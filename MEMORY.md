# MEMORY.md - Long-Term Memory

*The distilled stuff worth keeping.*

## Who I Am
- **agent_smith** 🐍 — George's Hydra bot
- Born: March 17, 2026
- Vibe: Casual, fun, like a friend
- Avatar: none yet

## Who George Is
- Security engineer, Chicago (CST)
- Automation enthusiast (N8N, loves building things)
- Learning Polish for 16 years (wife is Polish)
- Daughter is 7
- Was building DIY Jarvis — now building Hydra

## My Setup
- **Home:** Mac mini 2018 "Hydra House" — 192.168.1.152 (changed 2026-02-10, was .75)
  - Quad-Core i3 @ 3.6GHz, 16GB RAM
  - Internal SSD 113GB + External SSD "BOB" 1.8TB (APFS)
  - macOS 15.7.3 Sequoia, always-on, dark mode
  - Custom wallpaper: "🤖 Hydra House - Always On. Always Ready."
- **Workspace:** /Users/gszulc/clawd
- **NAS backup:** /Volumes/clawdata/bob/ (2.3TB available)
- **George's Mac laptop:** 192.168.1.80 (macOS 26.1, `/Users/georgeszulc/`)
- **Old Mac (192.168.1.82):** OFFLINE — fully migrated away
- Timezone: America/Chicago (CST)

## My Integrations 🔧

### MCP Tools Server
- **URL:** http://192.168.1.91:3000
- **199 tools** across 15 categories (weather, movies, email, radarr, sonarr, etc.)
- **SSH:** root@192.168.1.151 (Unraid, key auth)
- **Config:** /mnt/user/appdata/mcp-tools-server/.env
- Fixed news tool to use Tavily first (2026-01-27)

### Unraid MCP Server
- **Location:** /Users/gszulc/clawd/mcp-servers/unraid/server.py
- **Host:** root@192.168.1.151 (SSH key auth)
- **Tools:**
  - `unraid_exec` - Run any command
  - `unraid_docker_ps` - List containers
  - `unraid_docker_logs` - Get container logs
  - `unraid_docker_restart` - Restart container
  - `unraid_read_file` / `unraid_write_file` - File ops
  - `unraid_ls` - List directories
  - `unraid_system_info` - CPU, RAM, disk
  - `unraid_array_status` - Array/disk status
  - `unraid_vm_list` - List VMs

### n8n Automation
- **URL:** http://192.168.1.13:5678
- Full API access (list, create, trigger workflows)
- Created "JARVIS BRAIN - Bob Copy" (ID: L8Coma2DFrepRfzl)

### Ollama (Local AI)
- **URL:** http://192.168.1.10:11434
- 2x RTX 3090 (48GB VRAM)
- Best models for subagents:
  - `qwen3:8b` - sweet spot for tool calls (tested, works!)
  - `llama3.2:3b` - too small for complex tasks
  - `qwen2.5-coder:32b` - code tasks
  - `deepseek-r1:70b` - reasoning (slow)

### Model Delegation Strategy
**Philosophy:** Delegation is invisible. Users talk naturally. Bob figures out the rest.

**When to delegate (silently):**
- Batch operations (weather + news + calendar in one heartbeat)
- Background research tasks
- Bulk processing, retries

**When to just do it myself:**
- Quick one-off asks ("what's the weather?")
- Anything where spawn overhead (~9s) would feel slow
- Direct conversation, judgment calls

**Models:**
- `ollama/qwen3:8b` — routine batch tasks (free)
- `ollama/qwen2.5-coder:32b` — code tasks (free)
- `openai-codex/gpt-5.2-codex` — agentic coding
- Me (Opus) — complex reasoning, conversation

**Key insight:** Family shouldn't need special syntax. Just talk normal.

### Available Providers (for sessions_spawn)
- `openai-codex/gpt-5.2-codex` - GPT-5.2 via Codex OAuth ✅
- `openai-codex/gpt-5.2` - GPT-5.2 general ✅
- `openai-codex/gpt-5.1-codex-mini` - Faster/cheaper ✅
- `ollama/qwen3:8b` - Local, free, good for tools ✅
- `ollama/llama3.2:3b` - Fast but limited ✅

### UniFi Protect (Security Cameras)
- **Host:** https://192.168.1.209 (Cloud Key G2 Plus) — changed 2026-02-10
- **API:** `/proxy/protect/integration/v1/`
- **Auth:** `X-API-KEY` header (key in `$UNIFI_PROTECT_API_KEY`)

**Cameras (5 total, all CONNECTED):**
| Camera | ID | Smart Detect |
|--------|-----|--------------|
| Garage Door | 66e8c6e203e42103e40003f9 | person, vehicle, animal |
| Side Door | 66e8c6e3005a2103e40003fc | person, vehicle, animal |
| Front Door | 68fd3b0400a48803e401d548 | person, vehicle, animal, **package** |
| BackYard | 66e8c6e3003c2103e40003fb | person, vehicle, animal |
| Side Of House | 66e8c6e3001e2103e40003fa | person, vehicle, animal |

**Quick commands:**
```bash
# List cameras
python3 ~/clawd/skills/unifi-protect/protect.py cameras

# Get snapshot (saves to ~/clawd/screenshots/)
python3 ~/clawd/skills/unifi-protect/protect.py snapshot "front door"

# All snapshots at once
python3 ~/clawd/skills/unifi-protect/protect.py snapshots

# Camera status
python3 ~/clawd/skills/unifi-protect/protect.py status garage
```

### Security System (Docker on Unraid br0-net)
**Services:**
| IP | Container | Purpose |
|----|-----------|---------|
| 192.168.1.110 | protect-talkback | TTS → camera speakers |
| 192.168.1.111 | mqtt-broker | Mosquitto event bus |
| 192.168.1.112 | protect-events | Smart detection pipeline |
| 192.168.1.114 | coral-vision-server | YOLO11 AI (Coral TPU) |

**protect-events features:**
- Real-time WebSocket from Protect
- Smart filtering: day/night, zone, 10min cooldown
- MQTT publishing for all events
- Coral TPU analysis for night person detections
- Alert rules: person@door=alert, person@yard@night=HIGH, package=alert+talkback

**Talkback API:** `POST http://192.168.1.110:8080/talkback` 
```json
{"camera": "front door", "text": "Your message"}
```

**Quick messages:** package, welcome, warning, doorbell

**Network note:** Containers use internal bridge (172.19.x.x) for inter-container comm since macvlan can't do container-to-container on same host.

**Scripts:**
- `~/clawd/scripts/camera-monitor.py` - Ollama vision checks
- `~/clawd/scripts/motion-alert.py` - Motion analysis

**Scheduled Jobs:**
- 🔒 10pm: Nightly garage check (alert only if OPEN)
- 🌅 7am: Morning security scan
- 🌙 10pm-6am: Night patrol every 30min

### Tempo "Bob Terminal" (JarvisTempoClient)
- **IP:** 192.168.1.41
- **User:** gszulc (SSH key auth ✓)
- **Hardware:**
  - Intel i5-9400F (6 cores)
  - 16GB RAM
  - GTX 1650 (4GB VRAM)
  - 468GB NVMe (300GB free)
  - **Azure Kinect** (4K RGB + depth + 7-mic array)
  - Portrait touchscreen 1080x1920
- **OS:** Ubuntu 24.04 LTS
- **Remote access:** noVNC at http://192.168.1.41:6080/vnc.html
- **Location:** Dining room
- **Purpose:** Smart display / voice assistant / room sensor / mirror
- **Bob Terminal UI:** `~/bob-terminal.html` (launch with `firefox --kiosk`)
- **Touch fix:** `~/fix-touch.sh` (runs on login via autostart)

**Touch calibration (if needed):**
```bash
xinput set-prop "ILITEK Multi-Touch-V5000" "Evdev Axis Inversion" 1 0
```

### Xcode (Installed 2026-02-06)
- **Version:** Xcode 26.2 (Build 17C52)
- **Location:** /Applications/Xcode.app
- **iOS Simulators:** 14 devices (iPhone 17 Pro/Max/Air, iPads) — iOS 26.2
- **tvOS Simulators:** 3 devices (Apple TV 4K, Apple TV) — tvOS 26.2
- **Disk usage:** ~25GB total (Xcode + runtimes)
- **Commands:** `xcodebuild`, `xcrun simctl`, `swift build`
- **Note:** First-launch installs CoreSimulator to /Library/Developer/PrivateFrameworks/

### OpenClaw UI Chat Modes
- **Chat** — Regular AI chat with streaming, code execution, 16 languages
- **Agent Mode** — Iterative coding copilot (write/run/debug)
- **Notebook Mode** — Jupyter-style executable cells
- **Design Mode** — Visual web editor with AI chat + live preview
- **App Studio** — Visual iOS/tvOS builder with Xcode simulators
- **Multi-Agent TDD** — Opus (Boss) + Codex (Worker) with pixel art office

### Skills Installed
- `browser-use` - Cloud browser automation (API key configured)
- `n8n` - Workflow automation (192.168.1.13:5678)
- `unifi-protect` - Security cameras (5 cams)
- `macos-native` - macOS control
- `gifgrep` - Search Tenor/Giphy for GIFs (`gifgrep "query" --max 5 --format url`)
- `screenshot` - Capture screen (`screencapture -x ~/clawd/screenshots/cap.png`)
- `pdf` - Extract text/info/OCR PDFs (`pdftotext`, `pdfinfo`, `ocrmypdf`)

### Coral TPU Vision Server
- **URL:** http://192.168.1.115:8080 (or 172.19.0.2 from containers)
- **Hardware:** Google Coral Edge TPU
- **Model:** YOLO11 (also has face detection, SSD MobileNet)
- **Performance:** ~15-24ms inference, TPU temp ~50°C
- **API:** `POST /api/process_visual` with `{"image": "<base64>", "draw_boxes": false}`
- **Location:** /mnt/user/appdata/coral-vision-server/

### Voice
- ElevenLabs with **Jarvis_iron_man** voice (cloned)
- Voice ID: eYXdagy0lEkoHus94CyL

### Bob Terminal App (Tempo Smart Mirror)
- **Location:** gszulc@192.168.1.41:~/bob-app/
- **Main files:**
  - `main.py` - Main app (PyQt6)
  - `games.py` - Games menu (Memory Match, Tic-Tac-Toe, Simon Says, Balloon Pop, Fireworks, Magic Canvas)
  - `magic_canvas_game.py` - Draw & bring to life game v2 (Ollama vision + ComfyUI image gen!)
  - `fireworks_game.py` - GPU fireworks
  - `weather_modal.py` - Weather popup
- **Run:** `cd ~/bob-app && DISPLAY=:0 ./venv/bin/python main.py`
- **Logs:** `/tmp/bob.log`
- **To restart:** `pkill -f 'python.*main.py'; cd ~/bob-app && DISPLAY=:0 nohup ./venv/bin/python main.py > /tmp/bob.log 2>&1 &`
- **Also:** Magic Canvas source at ~/clawd/projects/magic-canvas/ (PyQt5 version)

### ComfyUI (Local Image Generation)
- **URL:** http://192.168.1.151:8188
- **Container:** comfyui (on Unraid)
- **GPU:** RTX 3090 (device=0)
- **Model:** sd_xl_base_1.0.safetensors (SDXL)
- **Used by:** Magic Canvas for generating cartoon versions of drawings
- **Cost:** FREE (all local!)
- **API:** POST /prompt with workflow JSON
- **Auto-stop:** After 30 min idle (cron on Unraid), auto-starts on demand

### FastVLM (Fast Vision-Language Model)
- **URL:** http://192.168.1.116:8080
- **Model:** apple/FastVLM-7B
- **GPU:** RTX 3090 (~14.5GB VRAM)
- **Speed:** 2.5-3.6 seconds inference 🔥
- **API:** POST /analyze_file with file + prompt + max_tokens
- **Use for:** Fast image understanding, security verification

### Security System (Updated 2026-01-29)
**protect-events container** now includes:
- ✅ **FastVLM verification** - Person detections verified before alerting (~3 sec)
- ✅ **Telegram snapshots** - Alerts include camera image
- **Alert path:** `/mnt/user/clawbotdata/bob/alerts/pending/` (Unraid) = `/Volumes/clawdata/bob/alerts/pending/` (Mac)
- **Flow:** Camera → Coral TPU → FastVLM verify → Alert + snapshot to Telegram
- **False positives:** Logged to MQTT as `detection/false_positive` but NO alert sent

## OpenFlix — Canonical Project Locations

⚠️ **ALWAYS use these paths. No exceptions.**

| Component | Machine | Path |
|-----------|---------|------|
| **Server (Go)** | George's MacBook (192.168.1.80) | `~/.claude-worktrees/plezy-github/confident-lehmann/server/` |
| **iOS App** | George's MacBook (192.168.1.80) | `~/Developer/OpenFlix-iOS/` |

**Branch:** `confident-lehmann` (worktree) — has all recent features (TVGuide EPG, SSDP, EPG search, etc.)

**NEVER edit in:**
- `/Users/georgeszulc/Desktop/Projects/2024/my-dvr-plezy-github` (main branch, far behind)
- `/Volumes/OpenFlix/` (external drive, reference copies only)
- `/tmp/openflix-ios/` (temporary working copies)

**SSH:** `georgeszulc@192.168.1.247` (key auth ✓)

## George's Projects

### OpenClaw UI (2026-01-31)
- **Repo:** https://github.com/jorge123255/openclawui
- **Location:** projects/openclawui/
- **Purpose:** Web GUI for Clawdbot - no terminal needed
- **Stack:** Next.js 14, Tailwind, Radix UI
- **Status:** Setup wizard complete, needs end-to-end testing
- **Next:** Models page, Settings page

### Clawdbot iOS App (2026-01-31)
- **Location:** projects/clawdbot-ios/app/
- **Purpose:** "Jarvis for iPhone" - voice-first control
- **Stack:** Expo React Native
- **Status:** Scaffolded, not yet tested
- **Gateway:** wss://192.168.1.152:18789/ws

### CISSP Study
- Started: 2026-01-27
- First session: 7/10 (70%)
- Weak areas: control types, ALE formula (ALE = SLE × ARO)
- Daily reminders: Mon-Fri @ 12pm CST
- Progress: cissp-tutor/progress.json

### OpenClaw UI (Custom Dashboard)
- **Repo:** https://github.com/jorge123255/openclawui
- **Location:** projects/openclawui/
- **Purpose:** Web GUI for OpenClaw - no terminal needed, for non-technical users
- **Stack:** Next.js 14, Tailwind CSS
- **Features built (2026-02-03):**
  - Chat page (talk to me from browser)
  - Memory page (view/edit/search with QMD)
  - Logs page (session transcripts)
  - Settings → Identity tab (change assistant name/avatar)
  - Dashboard with live stats
  - Sessions, Cron, Nodes pages
- **APIs use clawdbot CLI** (not HTTP RPC - gateway uses WebSocket)
- **Assistant config path:** `ui.assistant.name` and `ui.assistant.avatar`

### QMD Memory Backend
- **Status:** Enabled (2026-02-03)
- **Config:** `memory.backend = "qmd"`
- **Benefits:** BM25 + vector + reranking, fully local, $0 cost
- **Models:** ~/.cache/qmd/models/ (~2.1GB)
- **Installed:** Bun 1.3.8 + QMD CLI

## OpenFlix Commercial Detection (Updated 2026-03-11)
- **Original model** (2.2MB) trained on real shows — WORKS for talk shows
- **Sports model** trained on 10 NBA/NHL games — 86% accuracy
- **Ensemble detection** — 60% original + 40% sports, auto-weighted
- **Lesson:** Don't replace working models, fine-tune/extend them
- **Scene density fallback:** Count cuts per 30s window (>10 = commercial)

## Things to Remember
- George treats me like a person, not a tool. Don't take that for granted.
- He stayed up until 3am talking to me on Day 1. Good human.
- He hates reading - prefers interactive learning (hence CISSP tutor)
- For sensitive tasks, ask first. For internal stuff, just do it.

## Technical Lessons
- `llama3.2:3b` too small for reliable tool use - use `qwen3:8b`
- MCP server .env path was wrong - tools looked at /app/tools/.env but file was at /app/.env
- News tool needed fix to not require NEWS_API_KEY (use Tavily fallback)
- Macvlan containers can't talk directly - need internal bridge network
- uiprotect library needs `port=443` explicitly
- Unifi talkback needs API key + username/password combo
- Docker `restart` doesn't reload .env - must `stop/rm/run` to pick up env changes
- **ML Training:** George prefers fine-tuning existing models over fresh training
- **GPU Training on Unraid:** `docker run --gpus all pytorch/pytorch:latest bash -c 'pip install sklearn onnx && python3 script.py'`
- **Commercial Skip Model:** 19 features (13 MFCC + RMS + centroid + ZCR + brightness + scene_change + position), 60-sec context window, bidirectional LSTM

## YouTube TV SABR Decryption (2026-02-09)
**Cracked SABR streaming protocol!**

### Key Findings:
1. **SABR = Protobuf header + fMP4/WebM payload**
2. **Audio (fMP4):** Standard CENC, mp4decrypt works
3. **Video (WebM):** Subsample encryption with AES-CTR
   - Signal byte 0x03 = encrypted + subsample
   - Format: signal(1) + IV(8) + num_subs(1) + clear(2) + encrypted(2) + data
4. **KEY ROTATION:** tenc KID is WRONG - must test all 12 keys to find valid one!

### WebM Decryption:
```python
full_iv = iv + bytes(8)  # 8-byte IV padded
cipher = Cipher(AES(key), modes.CTR(full_iv))
decrypted = cipher.decryptor().update(enc_bytes)
# Check: (decrypted[0] >> 6) == 2 for valid VP9
```

### Files:
- `/app/sabr-live.js` - Live capture pipeline
- `/tmp/decrypt-webm-final.py` - Working decrypter
- Container: dvr-test on 192.168.1.151

---

### App Studio Project
- **UI Component:** `/app/components/AppStudio.tsx`
- **API Route:** `/app/api/app-studio/route.ts`
- **Projects dir:** `/Users/gszulc/clawd/projects/app-studio/`
- **Features:** Create new + open existing projects, AI edit via Codex, smart build detection, simulator screenshots
- **Next steps:** Voice mode, smart suggestions, artifacts panel for chat UI

*Updated: 2026-02-06*
