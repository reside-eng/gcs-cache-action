import * as core from '@actions/core';
import * as glob from '@actions/glob';
import { Storage, Bucket } from '@google-cloud/storage';
import * as path from 'path';
import { withFile as withTemporaryFile } from 'tmp-promise';

import { CacheActionMetadata } from './gcs-utils';
import { getFailOnError } from './inputs';
import { messageOf, withRetries } from './retry';
import { getState, State } from './state';
import { createTar } from './tar-utils';

const METADATA_TIMEOUT_MS = 60000;
const TRANSFER_TIMEOUT_MS = 600000;

async function save(state: State, bucket: Bucket): Promise<void> {
  const targetFileName = state.targetFileName;
  const [targetFileExists] = await withRetries(
    'Check if the cache archive already exists',
    () => bucket.file(targetFileName).exists(),
    { attemptTimeoutMs: METADATA_TIMEOUT_MS },
  );

  core.debug(`Target file name: ${targetFileName}.`);

  if (targetFileExists) {
    console.log(
      '🌀 Skipping uploading cache as it already exists (probably due to another job).',
    );
    return;
  }

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const globber = await glob.create(state.path, {
    implicitDescendants: false,
  });

  const paths = await globber
    .glob()
    .then((files) => files.map((file) => path.relative(workspace, file)));

  core.debug(`Paths: ${JSON.stringify(paths)}.`);

  if (paths.length === 0) {
    console.log('🌀 Skipping uploading cache as no file matched the path.');
    return;
  }

  return withTemporaryFile(async (tmpFile) => {
    const compressionMethod = await core.group(
      '🗜️ Creating cache archive',
      () => createTar(tmpFile.path, paths, workspace),
    );

    const customMetadata: CacheActionMetadata = {
      'Cache-Action-Compression-Method': compressionMethod,
    };

    core.debug(`Metadata: ${JSON.stringify(customMetadata)}.`);

    await core.group('🌐 Uploading cache archive to bucket', () =>
      withRetries(
        `Upload '${targetFileName}'`,
        async () => {
          console.log(`🔹 Uploading file '${targetFileName}'...`);
          await bucket.upload(tmpFile.path, {
            destination: targetFileName,
            metadata: {
              metadata: customMetadata,
            },
          });
        },
        { attempts: 3, attemptTimeoutMs: TRANSFER_TIMEOUT_MS },
      ),
    );

    console.log('✅ Successfully saved cache.');
  });
}

async function main() {
  const state = getState();

  if (!state.bucket || !state.targetFileName) {
    console.log('🌀 Skipping cache save (no state saved by the main step).');
    return;
  }

  if (state.cacheHitKind === 'exact') {
    console.log(
      '🌀 Skipping uploading cache as the cache was hit by exact match.',
    );
    return;
  }

  try {
    await save(state, new Storage().bucket(state.bucket));
  } catch (err) {
    // Failing to save only costs the next run a cache miss: never fail the
    // job for it (transient errors were already retried)
    if (getFailOnError()) throw err;

    core.warning(`Cache save failed, skipping: ${messageOf(err)}`);
    console.log('⚠️ Cache save failed, skipping.');
  }
}

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
