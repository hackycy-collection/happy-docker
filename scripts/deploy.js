#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const scriptDir = __dirname;
const repoRoot = path.resolve(scriptDir, '..');
process.chdir(repoRoot);

const env = process.env;
const args = process.argv.slice(2);

if (args[0] === '-h' || args[0] === '--help') {
  usage();
  process.exit(0);
}

if (args.length > 1) {
  usage();
  process.exit(1);
}

const registry = env.REGISTRY || 'ccr.ccs.tencentyun.com';
const namespace = env.NAMESPACE || 'sooosin';
const upstreamRepo = env.UPSTREAM_REPO || 'https://github.com/slopus/happy.git';
const upstreamRef = env.UPSTREAM_REF || 'main';
const upstreamDir = env.UPSTREAM_DIR || 'upstream';
const tag = args[0] || env.TAG || 'latest';

let tencentUsername = env.TENCENT_USERNAME || env.TCR_USERNAME || '';
let tencentPassword = env.TENCENT_PASSWORD || env.TCR_PASSWORD || '';

if (!tencentUsername && env.USERNAME && /^\d+$/.test(env.USERNAME)) {
  tencentUsername = env.USERNAME;
}

if (!tencentPassword && env.PASSWORD) {
  tencentPassword = env.PASSWORD;
}

const images = [
  { name: 'happy-app', dockerfile: 'Dockerfile.webapp' },
  { name: 'happy-server', dockerfile: 'Dockerfile' },
];

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

async function main() {
  requireCommand('git');
  requireCommand('docker');

  if (!tencentUsername) {
    tencentUsername = await promptText('Tencent Cloud username: ');
  }

  if (!tencentPassword) {
    tencentPassword = await promptPassword('Tencent Cloud password: ');
  }

  if (!tencentUsername || !tencentPassword) {
    throw new Error('Tencent Cloud username and password are required.');
  }

  const upstreamPath = path.resolve(repoRoot, upstreamDir);
  prepareUpstreamRepository(upstreamPath);

  const upstreamSha = runCapture('git', ['-C', upstreamPath, 'rev-parse', 'HEAD']);

  console.log(`Logging in to ${registry}...`);
  run('docker', ['login', registry, '--username', tencentUsername, '--password-stdin'], {
    input: `${tencentPassword}\n`,
  });

  ensureBuildxBuilder();

  for (const image of images) {
    const imageRef = `${registry}/${namespace}/${image.name}`;
    const dockerfilePath = path.join(upstreamPath, image.dockerfile);

    console.log(`Building and pushing ${imageRef}:${tag} from ${image.dockerfile}...`);
    run('docker', [
      'buildx',
      'build',
      '--file',
      dockerfilePath,
      '--label',
      'org.opencontainers.image.source=https://github.com/slopus/happy',
      '--label',
      `org.opencontainers.image.revision=${upstreamSha}`,
      '--tag',
      `${imageRef}:${tag}`,
      '--tag',
      `${imageRef}:sha-${upstreamSha}`,
      '--push',
      upstreamPath,
    ]);
  }

  console.log(`Done. Published tag '${tag}' and 'sha-${upstreamSha}' for happy-app and happy-server.`);
}

function usage() {
  console.log(`Usage: scripts/deploy.js [tag]

Environment variables:
  TENCENT_USERNAME  Tencent Cloud account ID, for example 100000842583
  TENCENT_PASSWORD  Tencent Cloud Container Registry password
  REGISTRY          Docker registry, default: ccr.ccs.tencentyun.com
  NAMESPACE         Tencent Cloud namespace, default: sooosin
  UPSTREAM_DIR      Local clone directory, default: upstream
  UPSTREAM_REF      Upstream branch or tag, default: main

Examples:
  TENCENT_USERNAME=100000842583 TENCENT_PASSWORD='***' node scripts/deploy.js latest
  TCR_USERNAME=100000842583 TCR_PASSWORD='***' TAG=2026-06-11 node scripts/deploy.js`);
}

function prepareUpstreamRepository(upstreamPath) {
  const gitDir = path.join(upstreamPath, '.git');

  if (fs.existsSync(gitDir)) {
    console.log(`Updating upstream repository in ${path.relative(repoRoot, upstreamPath) || upstreamPath}...`);
    run('git', ['-C', upstreamPath, 'fetch', '--depth', '1', 'origin', upstreamRef]);
    run('git', ['-C', upstreamPath, 'checkout', '--detach', 'FETCH_HEAD']);
    return;
  }

  if (fs.existsSync(upstreamPath)) {
    throw new Error(`${upstreamPath} exists but is not a Git repository. Remove it or set UPSTREAM_DIR.`);
  }

  console.log(`Cloning upstream repository into ${path.relative(repoRoot, upstreamPath) || upstreamPath}...`);
  run('git', ['clone', '--depth', '1', '--branch', upstreamRef, upstreamRepo, upstreamPath]);
}

function ensureBuildxBuilder() {
  const inspectResult = spawnSync('docker', ['buildx', 'inspect'], { stdio: 'ignore' });

  if (inspectResult.status !== 0) {
    run('docker', ['buildx', 'create', '--use']);
  }

  run('docker', ['buildx', 'inspect', '--bootstrap']);
}

function requireCommand(commandName) {
  const result = spawnSync(commandName, ['--version'], { stdio: 'ignore' });

  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(`Missing required command: ${commandName}`);
  }

  if (result.status !== 0) {
    throw new Error(`Unable to run required command: ${commandName}`);
  }
}

function run(commandName, commandArgs, options = {}) {
  const result = spawnSync(commandName, commandArgs, {
    input: options.input,
    stdio: options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${commandName} ${commandArgs.join(' ')}`);
  }
}

function runCapture(commandName, commandArgs) {
  const result = spawnSync(commandName, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${commandName} ${commandArgs.join(' ')}`);
  }

  return result.stdout.trim();
}

function promptText(question) {
  return new Promise((resolve) => {
    const interfaceInstance = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    interfaceInstance.question(question, (answer) => {
      interfaceInstance.close();
      resolve(answer.trim());
    });
  });
}

function promptPassword(question) {
  return new Promise((resolve) => {
    const interfaceInstance = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    interfaceInstance._writeToOutput = function writeToOutput(stringToWrite) {
      if (stringToWrite === question) {
        interfaceInstance.output.write(stringToWrite);
      }
    };

    interfaceInstance.question(question, (answer) => {
      interfaceInstance.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}
