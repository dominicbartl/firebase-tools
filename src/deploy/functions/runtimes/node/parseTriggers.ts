import * as path from "path";
import * as _ from "lodash";
import { fork } from "child_process";

import { FirebaseError } from "../../../../error";
import { logger } from "../../../../logger";
import * as backend from "../../backend";
import * as api from "../../../../api";
import * as proto from "../../../../gcp/proto";
import * as args from "../../args";
import * as runtimes from "../../runtimes";

const TRIGGER_PARSER = path.resolve(__dirname, "./triggerParser.js");

export const GCS_EVENTS: Set<string> = new Set<string>([
  "google.cloud.storage.object.v1.finalized",
  "google.cloud.storage.object.v1.archived",
  "google.cloud.storage.object.v1.deleted",
  "google.cloud.storage.object.v1.metadataUpdated",
]);

export interface ScheduleRetryConfig {
  retryCount?: number;
  maxRetryDuration?: string;
  minBackoffDuration?: string;
  maxBackoffDuration?: string;
  maxDoublings?: number;
}

/**
 * Configuration options for scheduled functions.
 */
export interface ScheduleAnnotation {
  schedule: string;
  timeZone?: string;
  retryConfig?: ScheduleRetryConfig;
}

// Defined in firebase-functions/src/cloud-function.ts
export interface TriggerAnnotation {
  name: string;
  platform?: "gcfv1" | "gcfv2";
  labels?: Record<string, string>;
  entryPoint: string;
  vpcConnector?: string;
  vpcConnectorEgressSettings?: string;
  ingressSettings?: string;
  availableMemoryMb?: number;
  timeout?: proto.Duration;
  maxInstances?: number;
  minInstances?: number;
  serviceAccountEmail?: string;
  httpsTrigger?: {
    invoker?: string[];
  };
  eventTrigger?: {
    eventType: string;
    resource: string;
    // Deprecated
    service: string;
  };
  failurePolicy?: {};
  schedule?: ScheduleAnnotation;
  timeZone?: string;
  regions?: string[];
  concurrency?: number;
}

/**
 * Removes any inspect options (`inspect` or `inspect-brk`) from options so the forked process is able to run (otherwise
 * it'll inherit process values and will use the same port).
 * @param options From either `process.execArgv` or `NODE_OPTIONS` envar (which is a space separated string)
 * @return `options` without any `inspect` or `inspect-brk` values
 */
function removeInspectOptions(options: string[]): string[] {
  return options.filter((opt) => !opt.startsWith("--inspect"));
}

function parseTriggers(
  projectId: string,
  sourceDir: string,
  configValues: backend.RuntimeConfigValues,
  envs: backend.EnvironmentVariables
): Promise<TriggerAnnotation[]> {
  return new Promise((resolve, reject) => {
    const env = { ...envs } as NodeJS.ProcessEnv;
    env.GCLOUD_PROJECT = projectId;
    if (!_.isEmpty(configValues)) {
      env.CLOUD_RUNTIME_CONFIG = JSON.stringify(configValues);
    }

    const execArgv = removeInspectOptions(process.execArgv);
    if (env.NODE_OPTIONS) {
      env.NODE_OPTIONS = removeInspectOptions(env.NODE_OPTIONS.split(" ")).join(" ");
    }

    const parser = fork(TRIGGER_PARSER, [sourceDir], {
      silent: true,
      env: env,
      execArgv: execArgv,
    });

    parser.on("message", (message) => {
      if (message.triggers) {
        resolve(message.triggers);
      } else if (message.error) {
        reject(new FirebaseError(message.error, { exit: 1 }));
      }
    });

    parser.on("exit", (code) => {
      if (code !== 0) {
        reject(
          new FirebaseError(
            "There was an unknown problem while trying to parse function triggers.",
            { exit: 2 }
          )
        );
      }
    });
  });
}

// Currently we always use JS trigger parsing
export function useStrategy(context: args.Context): Promise<boolean> {
  return Promise.resolve(true);
}

export async function discoverBackend(
  projectId: string,
  sourceDir: string,
  runtime: runtimes.Runtime,
  configValues: backend.RuntimeConfigValues,
  envs: backend.EnvironmentVariables
): Promise<backend.Backend> {
  const triggerAnnotations = await parseTriggers(projectId, sourceDir, configValues, envs);
  const want: backend.Backend = { ...backend.empty(), environmentVariables: envs };
  for (const annotation of triggerAnnotations) {
    addResourcesToBackend(projectId, runtime, annotation, want);
  }
  return want;
}

export function addResourcesToBackend(
  projectId: string,
  runtime: runtimes.Runtime,
  annotation: TriggerAnnotation,
  want: backend.Backend
) {
  Object.freeze(annotation);
  // Every trigger annotation is at least a function
  for (const region of annotation.regions || [api.functionsDefaultRegion]) {
    let trigger: backend.HttpsTrigger | backend.EventTrigger;
    let triggered: backend.Triggered;

    // Missing both or have both trigger types
    if (!!annotation.httpsTrigger == !!annotation.eventTrigger) {
      throw new FirebaseError(
        "Unexpected annotation generated by the Firebase Functions SDK. This should never happen."
      );
    }

    if (annotation.httpsTrigger) {
      trigger = {};
      if (annotation.failurePolicy) {
        logger.warn(`Ignoring retry policy for HTTPS function ${annotation.name}`);
      }
      proto.copyIfPresent(trigger, annotation.httpsTrigger, "invoker");
      triggered = { httpsTrigger: trigger };
    } else {
      trigger = {
        eventType: annotation.eventTrigger!.eventType,
        eventFilters: {
          resource: annotation.eventTrigger!.resource,
        },
        retry: !!annotation.failurePolicy,
      };
      if (annotation.schedule) {
        triggered = { scheduleTrigger: annotation.schedule };
      } else {
        triggered = { eventTrigger: trigger };
      }

      if (GCS_EVENTS.has(annotation.eventTrigger?.eventType || "")) {
        trigger.eventFilters = {
          bucket: annotation.eventTrigger!.resource,
        };
        (triggered as backend.EventTriggered).eventTrigger.eventFilters = {
          bucket: annotation.eventTrigger!.resource,
        };
      }
    }
    const cloudFunctionName: backend.TargetIds = {
      id: annotation.name,
      region: region,
      project: projectId,
    };
    const cloudFunction: backend.FunctionSpec = {
      platform: annotation.platform || "gcfv1",
      ...cloudFunctionName,
      entryPoint: annotation.entryPoint,
      runtime: runtime,
      trigger: trigger,
    };
    const endpoint: backend.Endpoint = {
      platform: annotation.platform || "gcfv1",
      ...cloudFunctionName,
      entryPoint: annotation.entryPoint,
      runtime: runtime,
      ...triggered,
    };
    if (annotation.vpcConnector) {
      let maybeId = annotation.vpcConnector;
      if (!maybeId.includes("/")) {
        maybeId = `projects/${projectId}/locations/${region}/connectors/${maybeId}`;
      }
      cloudFunction.vpcConnector = maybeId;
      endpoint.vpcConnector = maybeId;
    }
    proto.copyIfPresent(
      cloudFunction,
      annotation,
      "concurrency",
      "serviceAccountEmail",
      "labels",
      "vpcConnectorEgressSettings",
      "ingressSettings",
      "timeout",
      "maxInstances",
      "minInstances",
      "availableMemoryMb"
    );
    proto.copyIfPresent(
      endpoint,
      annotation,
      "concurrency",
      "serviceAccountEmail",
      "labels",
      "vpcConnectorEgressSettings",
      "ingressSettings",
      "timeout",
      "maxInstances",
      "minInstances",
      "availableMemoryMb"
    );

    if (annotation.schedule) {
      want.requiredAPIs["pubsub"] = "pubsub.googleapis.com";
      want.requiredAPIs["scheduler"] = "cloudscheduler.googleapis.com";

      const id = backend.scheduleIdForFunction(cloudFunctionName);
      const schedule: backend.ScheduleSpec = {
        id,
        project: projectId,
        schedule: annotation.schedule.schedule,
        transport: "pubsub",
        targetService: cloudFunctionName,
      };
      proto.copyIfPresent(schedule, annotation.schedule, "timeZone", "retryConfig");
      want.schedules.push(schedule);
      const topic: backend.PubSubSpec = {
        id,
        project: projectId,
        labels: backend.SCHEDULED_FUNCTION_LABEL,
        targetService: cloudFunctionName,
      };
      want.topics.push(topic);

      // The firebase-functions SDK is missing the topic ID in the event trigger for
      // scheduled functions.
      if (backend.isEventTrigger(cloudFunction.trigger)) {
        cloudFunction.trigger.eventFilters.resource = `${cloudFunction.trigger.eventFilters.resource}/${id}`;
      }

      cloudFunction.labels = {
        ...cloudFunction.labels,
        "deployment-scheduled": "true",
      };
    }

    want.cloudFunctions.push(cloudFunction);
    want.endpoints[region] = want.endpoints[region] || {};
    want.endpoints[region][endpoint.id] = endpoint;
  }
}
