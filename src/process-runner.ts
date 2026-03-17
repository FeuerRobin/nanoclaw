/**
 * Process-based Agent Runner for NanoClaw
 *
 * Alternative to container-runner.ts for environments where Docker is not available
 * (e.g., already running inside a Pterodactyl container).
 *
 * Runs the agent-runner directly as a child process instead of in a container.
 * Security note: Without containerization, the agent has access to the host filesystem.
 * This is acceptable when NanoClaw itself is already running in an isolated container.
 */
import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

interface DirectoryMount {
  hostPath: string;
  targetPath: string;
  readonly: boolean;
}

/**
 * Build directory symlinks for process mode.
 * In process mode, we can't use volume mounts, so we create a workspace
 * with symlinks to the actual directories.
 */
function buildDirectoryMounts(
  group: RegisteredGroup,
  isMain: boolean,
): DirectoryMount[] {
  const mounts: DirectoryMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only
    mounts.push({
      hostPath: projectRoot,
      targetPath: 'project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      targetPath: 'group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      targetPath: 'group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        targetPath: 'global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    targetPath: 'claude',
    readonly: false,
  });

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    targetPath: 'ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    targetPath: 'agent-src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const mount of validatedMounts) {
      mounts.push({
        hostPath: mount.hostPath,
        targetPath: `extra/${path.basename(mount.containerPath)}`,
        readonly: mount.readonly,
      });
    }
  }

  return mounts;
}

/**
 * Create a temporary workspace with symlinks to mounted directories.
 * Returns the workspace path.
 */
function createWorkspace(
  mounts: DirectoryMount[],
  processName: string,
): string {
  const workspaceRoot = path.join(DATA_DIR, 'workspaces', processName);
  fs.mkdirSync(workspaceRoot, { recursive: true });

  // Create workspace structure
  const workspacePath = path.join(workspaceRoot, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });

  // Create symlinks for each mount
  for (const mount of mounts) {
    const linkPath = path.join(workspacePath, mount.targetPath);
    const linkDir = path.dirname(linkPath);
    fs.mkdirSync(linkDir, { recursive: true });

    // Remove existing symlink if it exists
    try {
      fs.unlinkSync(linkPath);
    } catch {
      // Ignore if doesn't exist
    }

    // Create symlink
    fs.symlinkSync(mount.hostPath, linkPath, 'dir');
  }

  return workspacePath;
}

export async function runProcessAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildDirectoryMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;

  logger.debug(
    {
      group: group.name,
      processName,
      mounts: mounts.map(
        (m) => `${m.hostPath} -> ${m.targetPath}${m.readonly ? ' (ro)' : ''}`,
      ),
    },
    'Process mount configuration',
  );

  // Create workspace with symlinks
  const workspacePath = createWorkspace(mounts, processName);

  logger.info(
    {
      group: group.name,
      processName,
      mountCount: mounts.length,
      isMain: input.isMain,
      workspacePath,
    },
    'Spawning process agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    // Build the agent-runner if needed
    const agentRunnerBuild = path.join(DATA_DIR, 'agent-runner-build');
    const agentRunnerSrc = path.join(process.cwd(), 'container', 'agent-runner');
    const agentRunnerTsConfig = path.join(agentRunnerSrc, 'tsconfig.json');

    if (!fs.existsSync(agentRunnerBuild)) {
      logger.info('Building agent-runner for process mode...');
      fs.mkdirSync(agentRunnerBuild, { recursive: true });

      // Copy package files
      fs.cpSync(
        path.join(agentRunnerSrc, 'package.json'),
        path.join(agentRunnerBuild, 'package.json'),
      );
      if (fs.existsSync(path.join(agentRunnerSrc, 'package-lock.json'))) {
        fs.cpSync(
          path.join(agentRunnerSrc, 'package-lock.json'),
          path.join(agentRunnerBuild, 'package-lock.json'),
        );
      }

      // Copy tsconfig
      fs.cpSync(agentRunnerTsConfig, path.join(agentRunnerBuild, 'tsconfig.json'));

      // Install dependencies synchronously
      try {
        execSync('npm install', { cwd: agentRunnerBuild, stdio: 'inherit' });
      } catch (err) {
        logger.error({ err }, 'Failed to install agent-runner dependencies');
        resolve({
          status: 'error',
          result: null,
          error: 'Failed to install agent-runner dependencies',
        });
        return;
      }
    }

    // Copy source files for this run
    const runSrcDir = path.join(workspacePath, 'agent-src');
    const runBuildDir = path.join(DATA_DIR, 'workspaces', processName, 'build');
    fs.mkdirSync(runBuildDir, { recursive: true });

    // Copy node_modules from build dir instead of symlinking (more reliable)
    fs.cpSync(
      path.join(agentRunnerBuild, 'node_modules'),
      path.join(runBuildDir, 'node_modules'),
      { recursive: true },
    );

    // Copy tsconfig
    fs.cpSync(
      path.join(agentRunnerBuild, 'tsconfig.json'),
      path.join(runSrcDir, 'tsconfig.json'),
    );

    // Set up environment for the agent process
    const agentEnv: Record<string, string | undefined> = {
      ...process.env,
      TZ: TIMEZONE,
      ANTHROPIC_BASE_URL: `http://localhost:${CREDENTIAL_PROXY_PORT}`,
      HOME: path.join(workspacePath, 'claude'),
    };

    // Set auth credentials (placeholder values, real ones injected by proxy)
    const authMode = detectAuthMode();
    if (authMode === 'api-key') {
      agentEnv.ANTHROPIC_API_KEY = 'placeholder';
    } else {
      agentEnv.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder';
    }

    // Compile TypeScript and run the agent
    const compileCmd = `npx tsc --outDir "${runBuildDir}" --project "${runSrcDir}/tsconfig.json" 2>&1`;

    exec(compileCmd, (compileErr, compileStdout, compileStderr) => {
      if (compileErr) {
        logger.error(
          { err: compileErr, stdout: compileStdout, stderr: compileStderr },
          'Failed to compile agent-runner',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to compile agent-runner: ${compileStderr}`,
        });
        return;
      }

      // Run the compiled agent
      const agentProcess = spawn(
        'node',
        [path.join(runBuildDir, 'index.js')],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: path.join(workspacePath, 'group'),
          env: agentEnv,
        },
      );

      onProcess(agentProcess, processName);

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;

      agentProcess.stdin.write(JSON.stringify(input));
      agentProcess.stdin.end();

      // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
      let parseBuffer = '';
      let newSessionId: string | undefined;
      let outputChain = Promise.resolve();

      agentProcess.stdout.on('data', (data) => {
        const chunk = data.toString();

        // Always accumulate for logging
        if (!stdoutTruncated) {
          const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
          if (chunk.length > remaining) {
            stdout += chunk.slice(0, remaining);
            stdoutTruncated = true;
            logger.warn(
              { group: group.name, size: stdout.length },
              'Process stdout truncated due to size limit',
            );
          } else {
            stdout += chunk;
          }
        }

        // Stream-parse for output markers
        if (onOutput) {
          parseBuffer += chunk;
          let startIdx: number;
          while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
            const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
            if (endIdx === -1) break; // Incomplete pair, wait for more data

            const jsonStr = parseBuffer
              .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
              .trim();
            parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

            try {
              const parsed: ContainerOutput = JSON.parse(jsonStr);
              if (parsed.newSessionId) {
                newSessionId = parsed.newSessionId;
              }
              hadStreamingOutput = true;
              // Activity detected — reset the hard timeout
              resetTimeout();
              outputChain = outputChain.then(() => onOutput(parsed));
            } catch (err) {
              logger.warn(
                { group: group.name, error: err },
                'Failed to parse streamed output chunk',
              );
            }
          }
        }
      });

      agentProcess.stderr.on('data', (data) => {
        const chunk = data.toString();
        const lines = chunk.trim().split('\n');
        for (const line of lines) {
          if (line) logger.debug({ process: group.folder }, line);
        }
        if (stderrTruncated) return;
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
          logger.warn(
            { group: group.name, size: stderr.length },
            'Process stderr truncated due to size limit',
          );
        } else {
          stderr += chunk;
        }
      });

      let timedOut = false;
      let hadStreamingOutput = false;
      const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
      const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, processName },
          'Process timeout, stopping gracefully',
        );
        agentProcess.kill('SIGTERM');
        setTimeout(() => {
          if (!agentProcess.killed) {
            logger.warn(
              { group: group.name, processName },
              'Graceful stop failed, force killing',
            );
            agentProcess.kill('SIGKILL');
          }
        }, 15000);
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };

      agentProcess.on('close', (code) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        // Clean up workspace
        try {
          fs.rmSync(path.join(DATA_DIR, 'workspaces', processName), {
            recursive: true,
            force: true,
          });
        } catch (err) {
          logger.warn({ err }, 'Failed to clean up workspace');
        }

        if (timedOut) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const timeoutLog = path.join(logsDir, `process-${ts}.log`);
          fs.writeFileSync(
            timeoutLog,
            [
              `=== Process Run Log (TIMEOUT) ===`,
              `Timestamp: ${new Date().toISOString()}`,
              `Group: ${group.name}`,
              `Process: ${processName}`,
              `Duration: ${duration}ms`,
              `Exit Code: ${code}`,
              `Had Streaming Output: ${hadStreamingOutput}`,
            ].join('\n'),
          );

          if (hadStreamingOutput) {
            logger.info(
              { group: group.name, processName, duration, code },
              'Process timed out after output (idle cleanup)',
            );
            outputChain.then(() => {
              resolve({
                status: 'success',
                result: null,
                newSessionId,
              });
            });
            return;
          }

          logger.error(
            { group: group.name, processName, duration, code },
            'Process timed out with no output',
          );

          resolve({
            status: 'error',
            result: null,
            error: `Process timed out after ${configTimeout}ms`,
          });
          return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `process-${timestamp}.log`);
        const isVerbose =
          process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

        const logLines = [
          `=== Process Run Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `IsMain: ${input.isMain}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Stdout Truncated: ${stdoutTruncated}`,
          `Stderr Truncated: ${stderrTruncated}`,
          ``,
        ];

        const isError = code !== 0;

        if (isVerbose || isError) {
          logLines.push(
            `=== Input ===`,
            JSON.stringify(input, null, 2),
            ``,
            `=== Mounts ===`,
            mounts
              .map(
                (m) =>
                  `${m.hostPath} -> ${m.targetPath}${m.readonly ? ' (ro)' : ''}`,
              )
              .join('\n'),
            ``,
            `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
            stderr,
            ``,
            `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
            stdout,
          );
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
            `=== Mounts ===`,
            mounts.map((m) => `${m.targetPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
            ``,
          );
        }

        fs.writeFileSync(logFile, logLines.join('\n'));
        logger.debug({ logFile, verbose: isVerbose }, 'Process log written');

        if (code !== 0) {
          logger.error(
            {
              group: group.name,
              code,
              duration,
              stderr,
              stdout,
              logFile,
            },
            'Process exited with error',
          );

          resolve({
            status: 'error',
            result: null,
            error: `Process exited with code ${code}: ${stderr.slice(-200)}`,
          });
          return;
        }

        // Streaming mode: wait for output chain to settle
        if (onOutput) {
          outputChain.then(() => {
            logger.info(
              { group: group.name, duration, newSessionId },
              'Process completed (streaming mode)',
            );
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        // Legacy mode: parse the last output marker pair
        try {
          const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
          const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

          let jsonLine: string;
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            jsonLine = stdout
              .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
              .trim();
          } else {
            const lines = stdout.trim().split('\n');
            jsonLine = lines[lines.length - 1];
          }

          const output: ContainerOutput = JSON.parse(jsonLine);

          logger.info(
            {
              group: group.name,
              duration,
              status: output.status,
              hasResult: !!output.result,
            },
            'Process completed',
          );

          resolve(output);
        } catch (err) {
          logger.error(
            {
              group: group.name,
              stdout,
              stderr,
              error: err,
            },
            'Failed to parse process output',
          );

          resolve({
            status: 'error',
            result: null,
            error: `Failed to parse process output: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });

      agentProcess.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(
          { group: group.name, processName, error: err },
          'Process spawn error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Process spawn error: ${err.message}`,
        });
      });
    });
  });
}
