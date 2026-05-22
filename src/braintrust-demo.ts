import { flush, initLogger } from "braintrust";

export const defaultProjectName = "coding-agent-one-shot-demo";

let didInitLogger = false;

export function projectName() {
  return process.env.BRAINTRUST_PROJECT_NAME || defaultProjectName;
}

export function initDemoLogger() {
  if (!process.env.BRAINTRUST_API_KEY || didInitLogger) {
    return;
  }

  initLogger({
    projectName: projectName(),
    setCurrent: true,
    asyncFlush: true
  });
  didInitLogger = true;
}

export async function flushBraintrust() {
  if (!process.env.BRAINTRUST_API_KEY) {
    return;
  }
  await flush();
}
