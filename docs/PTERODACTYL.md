# Running NanoClaw in Pterodactyl

NanoClaw can run inside Pterodactyl without requiring Docker. When NanoClaw detects that it's running inside a container, it automatically switches to **process mode** where agents run as native child processes instead of nested containers.

## How It Works

### Automatic Detection

NanoClaw automatically detects containerized environments by checking for:
1. `/.dockerenv` file (Docker containers)
2. Container patterns in `/proc/1/cgroup` (Docker, LXC, Kubernetes)
3. `PTERODACTYL` environment variable (Pterodactyl-specific)

When detected, NanoClaw switches from Docker mode to process mode automatically.

### Process Mode vs Docker Mode

**Docker Mode (default on bare metal):**
- Agents run in isolated Linux containers
- Maximum security through OS-level isolation
- Requires Docker/Apple Container installed
- Each agent gets its own container with mounted directories

**Process Mode (auto-enabled in containers):**
- Agents run as child processes
- No nested containers (container-in-container not needed)
- Filesystem isolation via symlinks and workspace directories
- Suitable when NanoClaw itself is already containerized

## Setup in Pterodactyl

### Import Egg (recommended)

Import `/docs/egg-nanoclaw-openrouter.json` in your Pterodactyl panel to create a server preset that installs NanoClaw and configures OpenRouter with `stepfun/step-3.5-flash:free` by default.

### 1. Prerequisites

- Node.js 20+ installed in your Pterodactyl container
- Claude API key (get from https://console.anthropic.com)
- Sufficient RAM (recommended: 2GB minimum, 4GB+ for heavy usage)

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/qwibitai/nanoclaw.git
cd nanoclaw

# Install dependencies
npm install

# Build the project
npm run build
```

### 3. Configuration

Create a `.env` file in the project root:

```bash
# Your Claude API key
ANTHROPIC_API_KEY=sk-ant-...

# Assistant name (trigger word)
ASSISTANT_NAME=Andy

# Optional: Force process mode (auto-detected in Pterodactyl)
RUNTIME_MODE=process

# Optional: Credential proxy port (default: 3001)
CREDENTIAL_PROXY_PORT=3001
```

### 4. Setup

Run the setup process with Claude Code:

```bash
# Install Claude Code if not already installed
npm install -g @anthropic-ai/claude-code

# Run setup
claude
```

Then in the Claude Code prompt:
```
/setup
```

Claude will guide you through:
- Channel authentication (WhatsApp, Telegram, etc.)
- Service configuration
- First message testing

**Note:** Since you're in process mode, Docker setup will be automatically skipped.

### 5. Running

Start NanoClaw:

```bash
npm start
```

Or use the built output:

```bash
node dist/index.js
```

### 6. Auto-start on Container Boot

Create a startup script for Pterodactyl:

**Option 1: Using PM2 (recommended)**

```bash
# Install PM2
npm install -g pm2

# Start NanoClaw with PM2
pm2 start dist/index.js --name nanoclaw

# Save PM2 process list
pm2 save

# Generate startup script
pm2 startup
```

**Option 2: Using systemd (if available in container)**

Create `/etc/systemd/user/nanoclaw.service`:

```ini
[Unit]
Description=NanoClaw AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/nanoclaw
ExecStart=/usr/bin/node /path/to/nanoclaw/dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Enable and start:
```bash
systemctl --user enable nanoclaw
systemctl --user start nanoclaw
```

## Monitoring and Logs

### View Logs

```bash
# If using PM2
pm2 logs nanoclaw

# If using systemd
journalctl --user -u nanoclaw -f

# Direct logs (if running in foreground)
tail -f logs/*.log
```

### Check Status

```bash
# If using PM2
pm2 status

# If using systemd
systemctl --user status nanoclaw
```

### Restart Service

```bash
# If using PM2
pm2 restart nanoclaw

# If using systemd
systemctl --user restart nanoclaw
```

## Resource Usage

### Memory

- **Minimum:** 512MB (basic usage, single group)
- **Recommended:** 2GB (multiple groups, scheduled tasks)
- **Heavy usage:** 4GB+ (many concurrent conversations, agent swarms)

The agent-runner dependencies are installed once and reused across invocations. Each agent process uses approximately 200-500MB depending on the task.

### CPU

- Minimal CPU usage when idle
- CPU spikes during agent invocations (TypeScript compilation, Claude API calls)
- Most CPU time is in the Claude API request/response cycle

### Storage

- **Base installation:** ~200MB (node_modules, built code)
- **Agent dependencies:** ~100MB (first run installs @anthropic-ai/claude-agent-sdk)
- **Session data:** Grows with usage (conversations, logs, task history)
- **Recommended:** 1GB+ free space

## Troubleshooting

### NanoClaw isn't detecting process mode

**Solution 1: Check detection**
```bash
node -e "const fs = require('fs'); console.log('dockerenv:', fs.existsSync('/.dockerenv')); console.log('PTERODACTYL:', process.env.PTERODACTYL);"
```

**Solution 2: Force process mode**
Add to `.env`:
```bash
RUNTIME_MODE=process
```

### Agent fails to start with "Cannot find module"

**Cause:** Agent-runner dependencies not installed

**Solution:**
```bash
# Remove cached build
rm -rf data/agent-runner-build

# Restart NanoClaw to trigger rebuild
npm start
```

### "Failed to compile agent-runner" error

**Cause:** TypeScript compilation issues

**Solution:**
```bash
# Ensure TypeScript is available
npm install -g typescript

# Or use local TypeScript
npx tsc --version
```

### High memory usage

**Cause:** Multiple concurrent agent processes

**Solution:**
Reduce concurrent agents in `.env`:
```bash
MAX_CONCURRENT_CONTAINERS=2
```

### Credential proxy errors

**Cause:** Port conflict or proxy not starting

**Solution:**
Change proxy port in `.env`:
```bash
CREDENTIAL_PROXY_PORT=3002
```

## Security Considerations

### Process Mode Security

In process mode, agents run as child processes without full container isolation. Security considerations:

1. **Filesystem access:** Agents can only access explicitly mounted directories (via symlinks)
2. **Process isolation:** Each agent runs as a separate process
3. **Credential protection:** API keys are never exposed to agents (proxied)
4. **Read-only mounts:** Project root and global memory are read-only

### Recommended Practices

1. **Run in a dedicated container:** NanoClaw should have its own Pterodactyl container
2. **Limit exposed ports:** Only expose necessary ports (e.g., if running a web interface)
3. **Regular updates:** Keep dependencies updated
4. **Monitor logs:** Watch for suspicious activity
5. **Restrict group access:** Only add trusted groups/users

## Advanced Configuration

### Custom Workspace Location

Set in code or environment:
```bash
# In .env
DATA_DIR=/custom/data/path
```

### Multiple Instances

Run multiple NanoClaw instances on different ports:

Instance 1 (.env.production):
```bash
CREDENTIAL_PROXY_PORT=3001
```

Instance 2 (.env.development):
```bash
CREDENTIAL_PROXY_PORT=3002
```

Start with:
```bash
NODE_ENV=production node dist/index.js
NODE_ENV=development node dist/index.js
```

### Debug Mode

Enable verbose logging:
```bash
LOG_LEVEL=debug npm start
```

## Performance Optimization

### Reduce Compilation Time

The agent-runner is compiled on each invocation. To reduce overhead:

1. **Reuse compiled output:** The build is cached in `data/agent-runner-build/`
2. **Warm start:** First invocation takes ~5-10 seconds, subsequent ones are faster
3. **Keep alive:** Containers/processes stay alive for 30 minutes after last use

### Speed Up Agent Response

1. **Reduce prompt size:** Shorter prompts = faster responses
2. **Limit context:** Compact old conversations regularly
3. **Optimize mounts:** Only mount necessary directories

## Getting Help

If you encounter issues:

1. **Check logs:** `tail -f logs/*.log` or `pm2 logs nanoclaw`
2. **Run debug:** In Claude Code, run `/debug`
3. **Ask Claude:** Describe the issue to Claude Code directly
4. **Community:** Join [Discord](https://discord.gg/VDdww8qS42)
5. **GitHub:** Open an issue at [github.com/qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)

## Migrating from Docker Mode

If you previously ran NanoClaw with Docker and want to migrate to Pterodactyl:

1. **Export data:**
   ```bash
   tar -czf nanoclaw-backup.tar.gz groups/ data/ store/ .env
   ```

2. **Transfer to Pterodactyl:**
   ```bash
   scp nanoclaw-backup.tar.gz user@pterodactyl-host:/path/to/nanoclaw/
   ```

3. **Extract and rebuild:**
   ```bash
   cd /path/to/nanoclaw
   tar -xzf nanoclaw-backup.tar.gz
   npm install
   npm run build
   npm start
   ```

4. **Verify process mode:**
   Check logs for: `Running in process mode (no container runtime needed)`

Your sessions, groups, and configuration will be preserved.
