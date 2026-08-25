import * as core from '@actions/core';
import * as github from '@actions/github';
import { Storage, File, Bucket } from '@google-cloud/storage';
import { promises as fs } from 'fs';

import { ObjectMetadata } from './gcs-utils';
import { getFailOnError, getInputs, Inputs } from './inputs';
import { failOpenOnUncaught, messageOf, withRetries } from './retry';
import { CacheHitKindState, saveState } from './state';
import { extractTar } from './tar-utils';

const METADATA_TIMEOUT_MS = 60000;
const TRANSFER_TIMEOUT_MS = 600000;

async function getBestMatch(
  bucket: Bucket,
  key: string,
  restoreKeys: string[],
): Promise<[File, Exclude<CacheHitKindState, 'none'>] | [null, 'none']> {
  const folderPrefix = `${github.context.repo.owner}/${github.context.repo.repo}`;

  core.debug(`Will lookup for the file ${folderPrefix}/${key}.tar`);

  const exactFile = bucket.file(`${folderPrefix}/${key}.tar`);
  const [exactFileExists] = await withRetries(
    'Check for an exact cache match',
    () => exactFile.exists(),
    { attemptTimeoutMs: METADATA_TIMEOUT_MS },
  );

  core.debug(`Exact file name: ${exactFile.name}.`);

  if (exactFileExists) {
    console.log(`🙌 Found exact match from cache for key '${key}'.`);
    return [exactFile, 'exact'];
  } else {
    console.log(`🔸 No exact match found for key '${key}'.`);
  }

  if (restoreKeys.length === 0) {
    return [null, 'none'];
  }

  const bucketFiles = await withRetries(
    'List cache candidates',
    () =>
      bucket.getFiles({
        prefix: `${folderPrefix}/${restoreKeys[restoreKeys.length - 1]}`,
      }),
    { attemptTimeoutMs: METADATA_TIMEOUT_MS },
  ).then(([files]) =>
    files.sort(
      (a, b) =>
        new Date((b.metadata as ObjectMetadata).updated).getTime() -
        new Date((a.metadata as ObjectMetadata).updated).getTime(),
    ),
  );

  if (core.isDebug()) {
    core.debug(
      `Candidates: ${JSON.stringify(
        bucketFiles.map((f) => ({
          name: f.name,
          metadata: {
            updated: (f.metadata as ObjectMetadata).updated,
          },
        })),
      )}.`,
    );
  }

  for (const restoreKey of restoreKeys) {
    const foundFile = bucketFiles.find((file) =>
      file.name.startsWith(`${folderPrefix}/${restoreKey}`),
    );

    if (foundFile) {
      console.log(`🤝 Found match from cache for restore key '${restoreKey}'.`);
      return [foundFile, 'partial'];
    } else {
      console.log(
        `🔸 No cache candidate found for restore key '${restoreKey}'.`,
      );
    }
  }

  return [null, 'none'];
}

async function restore(
  inputs: Inputs,
  bucket: Bucket,
  exactFileName: string,
): Promise<void> {
  const [bestMatch, bestMatchKind] = await core.group(
    '🔍 Searching the best cache archive available',
    () => getBestMatch(bucket, inputs.key, inputs.restoreKeys),
  );

  core.debug(`Best match kind: ${bestMatchKind}.`);

  if (!bestMatch) {
    console.log('😢 No cache candidate found.');
    return;
  }

  core.debug(`Best match name: ${bestMatch.name}.`);

  const bestMatchMetadata = await withRetries(
    'Read cache archive metadata',
    () =>
      bestMatch.getMetadata().then(([metadata]) => metadata as ObjectMetadata),
    { attemptTimeoutMs: METADATA_TIMEOUT_MS },
  );

  core.debug(`Best match metadata: ${JSON.stringify(bestMatchMetadata)}.`);

  const compressionMethod =
    bestMatchMetadata?.metadata?.['Cache-Action-Compression-Method'];

  core.debug(`Best match compression method: ${compressionMethod}.`);

  if (!bestMatchMetadata || !compressionMethod) {
    console.log('😢 No cache candidate found (missing metadata).');
    return;
  }

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const archivePath = `${workspace}/tmp.tar`;

  try {
    await core.group('🌐 Downloading cache archive from bucket', () =>
      withRetries(
        `Download '${bestMatch.name}'`,
        async () => {
          console.log(`🔹 Downloading file '${bestMatch.name}'...`);
          await bestMatch.download({ destination: archivePath });
        },
        { attempts: 3, attemptTimeoutMs: TRANSFER_TIMEOUT_MS },
      ),
    );

    await core.group('🗜️ Extracting cache archive', () =>
      extractTar(archivePath, compressionMethod, workspace),
    );
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
  }

  saveState({
    path: inputs.path,
    bucket: inputs.bucket,
    cacheHitKind: bestMatchKind,
    targetFileName: exactFileName,
  });
  core.setOutput('cache-hit', bestMatchKind === 'exact');
  console.log('✅ Successfully restored cache.');
}

async function main() {
  const inputs = getInputs();
  const bucket = new Storage().bucket(inputs.bucket);

  const folderPrefix = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const exactFileName = `${folderPrefix}/${inputs.key}.tar`;

  // Pre-seed the miss result: state and outputs are last-write-wins, so even
  // an uncaught crash mid-restore leaves the post step and downstream steps
  // with a valid cache-miss result
  saveState({
    bucket: inputs.bucket,
    path: inputs.path,
    cacheHitKind: 'none',
    targetFileName: exactFileName,
  });
  core.setOutput('cache-hit', 'false');

  try {
    await restore(inputs, bucket, exactFileName);
  } catch (err) {
    // A cache is an optimization, not a dependency: degrade to a cache miss
    // instead of failing the whole job (transient errors were already retried)
    if (inputs.failOnError) throw err;

    core.warning(
      `Cache restore failed, continuing without cache: ${messageOf(err)}`,
    );
    console.log('⚠️ Cache restore failed, continuing without cache.');
  }
}

failOpenOnUncaught('restore', getFailOnError);
void main()
  .catch((err: Error) => {
    core.error(err);
    core.setFailed(err);
  })
  .finally(() => {
    // A request abandoned by an attempt timeout can keep sockets open:
    // exit explicitly so the step never outlives its work
    process.exit(process.exitCode ?? 0);
  });
