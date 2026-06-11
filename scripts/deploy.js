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
const platforms = env.PLATFORMS || env.PLATFORM || 'linux/amd64,linux/arm64';
const buildxBuilder = env.BUILDX_BUILDER || 'happy-docker-builder';
const upstreamMarkerFile = '.happy-docker-upstream.json';

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
  const upstreamSha = prepareUpstreamRepository(upstreamPath);
  patchUpstreamDockerfiles(upstreamPath);

  console.log(`Logging in to ${registry}...`);
  run('docker', ['login', registry, '--username', tencentUsername, '--password-stdin'], {
    input: `${tencentPassword}\n`,
  });

  ensureBuildxBuilder();
  console.log(`Using Docker build platforms: ${platforms}`);

  for (const image of images) {
    const imageRef = `${registry}/${namespace}/${image.name}`;
    const dockerfilePath = path.join(upstreamPath, image.dockerfile);

    console.log(`Building and pushing ${imageRef}:${tag} from ${image.dockerfile}...`);
    run('docker', [
      'buildx',
      'build',
      '--platform',
      platforms,
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
  TENCENT_USERNAME  Tencent Cloud account ID, for example 'uname'
  TENCENT_PASSWORD  Tencent Cloud Container Registry password
  REGISTRY          Docker registry, default: ccr.ccs.tencentyun.com
  NAMESPACE         Tencent Cloud namespace, default: sooosin
  PLATFORMS         Docker build platforms, default: linux/amd64,linux/arm64
  BUILDX_BUILDER    Docker buildx builder name, default: happy-docker-builder
  UPSTREAM_DIR      Local clone directory, default: upstream
  UPSTREAM_REF      Upstream branch or tag, default: main

Examples:
  TENCENT_USERNAME='uname' TENCENT_PASSWORD='***' node scripts/deploy.js latest
  PLATFORMS=linux/amd64,linux/arm64 TENCENT_USERNAME='uname' TENCENT_PASSWORD='***' node scripts/deploy.js latest
  TCR_USERNAME='uname' TCR_PASSWORD='***' TAG=2026-06-11 node scripts/deploy.js`);
}

function prepareUpstreamRepository(upstreamPath) {
  assertSafeUpstreamPath(upstreamPath);

  const upstreamParent = path.dirname(upstreamPath);
  const upstreamName = path.basename(upstreamPath);
  const tempPath = path.join(upstreamParent, `.${upstreamName}.tmp-${process.pid}-${Date.now()}`);
  const displayPath = path.relative(repoRoot, upstreamPath) || upstreamPath;

  fs.mkdirSync(upstreamParent, { recursive: true });
  fs.rmSync(tempPath, { recursive: true, force: true });

  try {
    console.log(`Fetching upstream repository into ${displayPath} without .git...`);
    run('git', ['clone', '--depth', '1', '--branch', upstreamRef, upstreamRepo, tempPath]);

    const upstreamSha = runCapture('git', ['-C', tempPath, 'rev-parse', 'HEAD']);
    fs.rmSync(path.join(tempPath, '.git'), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(tempPath, upstreamMarkerFile),
      `${JSON.stringify({ repo: upstreamRepo, ref: upstreamRef, sha: upstreamSha }, null, 2)}\n`,
    );

    assertSafeToReplaceUpstreamPath(upstreamPath);
    fs.rmSync(upstreamPath, { recursive: true, force: true });
    fs.renameSync(tempPath, upstreamPath);

    return upstreamSha;
  } catch (error) {
    fs.rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

function assertSafeUpstreamPath(upstreamPath) {
  const relativePath = path.relative(repoRoot, upstreamPath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`UPSTREAM_DIR must resolve inside the repository and cannot be the repository root: ${upstreamPath}`);
  }
}

function assertSafeToReplaceUpstreamPath(upstreamPath) {
  if (!fs.existsSync(upstreamPath)) {
    return;
  }

  const stat = fs.statSync(upstreamPath);

  if (!stat.isDirectory()) {
    throw new Error(`${upstreamPath} exists but is not a directory. Remove it or set UPSTREAM_DIR.`);
  }

  if (fs.existsSync(path.join(upstreamPath, upstreamMarkerFile))) {
    return;
  }

  if (fs.existsSync(path.join(upstreamPath, '.git'))) {
    const remoteUrl = runCapture('git', ['-C', upstreamPath, 'config', '--get', 'remote.origin.url']);

    if (normalizeGitUrl(remoteUrl) === normalizeGitUrl(upstreamRepo)) {
      return;
    }
  }

  throw new Error(`${upstreamPath} already exists and does not look like a managed upstream cache. Remove it or set UPSTREAM_DIR.`);
}

function normalizeGitUrl(url) {
  return url.trim().replace(/\.git$/, '');
}

function patchUpstreamDockerfiles(upstreamPath) {
  const dockerfilePath = path.join(upstreamPath, 'Dockerfile');

  if (!fs.existsSync(dockerfilePath)) {
    return;
  }

  const replacements = [
    {
      from: 'RUN apt-get update && apt-get install -y python3 make g++ build-essential && rm -rf /var/lib/apt/lists/*',
      to: makeAptInstallRun('python3 make g++ build-essential'),
    },
    {
      from: 'RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*',
      to: makeAptInstallRun('ffmpeg curl'),
    },
  ];

  let dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  let patched = false;

  for (const replacement of replacements) {
    if (dockerfile.includes(replacement.from)) {
      dockerfile = dockerfile.replace(replacement.from, replacement.to);
      patched = true;
    }
  }

  if (patched) {
    fs.writeFileSync(dockerfilePath, dockerfile);
    console.log('Patched upstream Dockerfile apt installs with retries.');
  }
}

function makeAptInstallRun(packages) {
  return `RUN set -eux; \\
    echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries; \\
    echo 'Acquire::http::Timeout "30";' >> /etc/apt/apt.conf.d/80-retries; \\
    echo 'Acquire::https::Timeout "30";' >> /etc/apt/apt.conf.d/80-retries; \\
    echo 'Acquire::http::Pipeline-Depth "0";' >> /etc/apt/apt.conf.d/80-retries; \\
    for attempt in 1 2 3 4 5; do \\
      if apt-get update && apt-get install -y --no-install-recommends ${packages}; then \\
        break; \\
      fi; \\
      if [ "$attempt" = "5" ]; then \\
        exit 1; \\
      fi; \\
      rm -rf /var/lib/apt/lists/*; \\
      sleep $((attempt * 5)); \\
    done; \\
    rm -rf /var/lib/apt/lists/*`;
}

function ensureBuildxBuilder() {
  const inspectResult = spawnSync('docker', ['buildx', 'inspect', buildxBuilder], { stdio: 'ignore' });

  if (inspectResult.status !== 0) {
    run('docker', ['buildx', 'create', '--name', buildxBuilder, '--driver', 'docker-container', '--use']);
  } else {
    run('docker', ['buildx', 'use', buildxBuilder]);
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
