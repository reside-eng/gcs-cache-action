import * as core from '@actions/core';

export interface Inputs {
  bucket: string;
  path: string;
  key: string;
  restoreKeys: string[];
  failOnError: boolean;
}

export function getFailOnError(): boolean {
  return core.getInput('fail-on-error').toLowerCase() === 'true';
}

export function getInputs(): Inputs {
  const inputs = {
    bucket: core.getInput('bucket', { required: true }),
    path: core.getInput('path', { required: true }),
    key: core.getInput('key', { required: true }),
    // Accept both newline-separated (actions/cache style, what our
    // workflows pass) and comma-separated restore keys
    restoreKeys: core
      .getInput('restore-keys')
      .split(/[\n,]/)
      .map((key) => key.trim())
      .filter((key) => key),
    failOnError: getFailOnError(),
  };

  core.debug(`Loaded inputs: ${JSON.stringify(inputs)}.`);

  return inputs;
}
