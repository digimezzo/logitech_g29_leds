const dgram = require("dgram");
const HID = require("node-hid");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

// ===== CONFIG =====
const UDP_PORT = 20777;
const BEEP_ENABLED = process.argv.includes("--beep");

const VENDOR_ID = 0x046d;
const PRODUCT_ID = 0xc24f;

const FLASH_THRESHOLD = 0.9; // fraction of RPM range to start flashing (matches last LED)
const FLASH_INTERVAL = 50; // ms between on/off toggles (~10Hz)
const TELEMETRY_TIMEOUT = 2000; // ms without telemetry before turning off LEDs

const BEEP_FREQ = 3000; // Hz
const BEEP_DURATION = 0.4; // seconds
// ===== STATE =====
let device;
let previousMask = -1;
let idleRpm = 0;
let maxRpm = 0;
let flashTimer = null;
let flashOn = false;
let telemetryWatchdog = null;
let hasBeepedThisShift = false;
let previousGear = 0;

// ===== BEEP TONE =====
const BEEP_WAV_PATH = path.join("/tmp", "f1_g29_beep.wav");

function generateBeepWav(freq, duration, sampleRate = 44100) {
  const numSamples = Math.floor(sampleRate * duration);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample =
      Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.1 * 32767;
    buf.writeInt16LE(Math.round(sample), 44 + i * 2);
  }
  return buf;
}

if (BEEP_ENABLED) {
  fs.writeFileSync(BEEP_WAV_PATH, generateBeepWav(BEEP_FREQ, BEEP_DURATION));
}

function playBeep() {
  if (!BEEP_ENABLED) return;
  execFile("paplay", [BEEP_WAV_PATH], (err, stdout, stderr) => {
    if (err) console.log("🔊 Beep error:", err.message, stderr);
  });
}

// ===== CONNECT WHEEL =====
function connectWheel() {
  if (device) return;

  try {
    device = new HID.HID(VENDOR_ID, PRODUCT_ID);
    console.log("✅ G29 connected");
  } catch (err) {
    console.log("❌ Wheel not found");
    console.log(HID.devices());
    process.exit(1);
  }
}

// ===== LED OUTPUT =====
function writeLED(mask) {
  if (!device) return;
  device.write([0xf8, 0x12, mask, 0x00, 0x00, 0x00, 0x01]);
}

// ===== STARTUP RESET (ADDED) =====
function resetLEDsOnStartup() {
  if (!device) return;

  // small delay ensures HID is ready
  setTimeout(() => {
    writeLED(0x00);
    writeLED(0x00);

    previousMask = -1;

    console.log("🔄 Startup LED reset complete");
  }, 300);
}

// ===== CLEANUP =====
function shutdownLEDs() {
  stopFlashing();
  writeLED(0x00);
  previousMask = -1;
}

// ===== TELEMETRY WATCHDOG =====
function resetWatchdog() {
  if (telemetryWatchdog) clearTimeout(telemetryWatchdog);
  telemetryWatchdog = setTimeout(() => {
    shutdownLEDs();
    console.log("💤 No telemetry — LEDs off");
  }, TELEMETRY_TIMEOUT);
}

// ===== LED FLASH =====
function startFlashing() {
  if (flashTimer) return;
  flashOn = true;
  flashTimer = setInterval(() => {
    flashOn = !flashOn;
    writeLED(flashOn ? 0x1f : 0x00);
  }, FLASH_INTERVAL);
}

function stopFlashing() {
  if (!flashTimer) return;
  clearInterval(flashTimer);
  flashTimer = null;
  flashOn = false;
}

// ===== DIRECT LED LOGIC (NO SMOOTHING) =====
function updateLEDs(rpm) {
  if (maxRpm === 0) return; // no status packet received yet

  // map rpm to 0.0-1.0 within the usable range (idle to max)
  const range = maxRpm - idleRpm;
  const frac = Math.max(0, (rpm - idleRpm) / range);

  // flash all LEDs at shift point
  if (frac >= FLASH_THRESHOLD) {
    startFlashing();
    if (!hasBeepedThisShift) {
      playBeep();
      hasBeepedThisShift = true;
    }
    return;
  }

  // only reset beep flag when RPM drops well below threshold
  // (prevents re-beep on downshift RPM spikes that briefly cross the threshold)
  stopFlashing();

  let mask = 0x00;

  if (frac > 0.05) mask |= 0x01;
  if (frac > 0.25) mask |= 0x02;
  if (frac > 0.5) mask |= 0x04;
  if (frac > 0.75) mask |= 0x08;
  if (frac > 0.9) mask |= 0x10;

  // only send if changed (prevents USB spam)
  if (mask !== previousMask) {
    previousMask = mask;
    writeLED(mask);

    console.log(
      `RPM: ${rpm} | idle: ${idleRpm} | max: ${maxRpm} | ${(frac * 100).toFixed(1)}% | mask: ${mask.toString(2).padStart(5, "0")}`,
    );
  }
}

// ===== PACKET HANDLER =====
function handlePacket(msg) {
  try {
    if (msg.length < 100) return;

    const packetId = msg.readUInt8(5);
    const playerIndex = msg.readUInt8(22);
    if (playerIndex > 21) return;

    // Car Status packet (ID 7) — read real idle/max RPM
    if (packetId === 7) {
      const STATUS_CAR_SIZE = 47;
      const statusBase = 24 + playerIndex * STATUS_CAR_SIZE;
      const newMax = msg.readUInt16LE(statusBase + 17);
      const newIdle = msg.readUInt16LE(statusBase + 19);
      if (newMax > 0 && newMax < 20000) {
        if (maxRpm !== newMax || idleRpm !== newIdle) {
          maxRpm = newMax;
          idleRpm = newIdle;
          console.log(`📊 RPM range updated: idle=${idleRpm}, max=${maxRpm}`);
        }
      }
      return;
    }

    // Car Telemetry packet (ID 6)
    if (packetId !== 6) return;

    const TELEMETRY_CAR_SIZE = 60;
    const base = 24 + playerIndex * TELEMETRY_CAR_SIZE;

    const rpm = msg.readUInt16LE(base + 16);
    if (rpm <= 0 || rpm > 20000) return;

    const gear = msg.readInt8(base + 15);
    if (gear > previousGear) {
      hasBeepedThisShift = false; // upshift — allow beep for new gear
    }
    previousGear = gear;

    updateLEDs(rpm);
    resetWatchdog();
  } catch (err) {
    console.log("Packet error:", err.message);
  }
}

// ===== START =====
connectWheel();

// 🔥 ADDED: safe startup reset (does NOT interfere with your working logic)
resetLEDsOnStartup();

const socket = dgram.createSocket("udp4");

socket.on("message", handlePacket);

socket.on("listening", () => {
  console.log(`📡 Listening on UDP ${UDP_PORT}`);
});

socket.bind(20777);

// ===== CLEAN EXIT =====
process.on("SIGINT", () => {
  shutdownLEDs();
  console.log("\n🛑 LEDs off — exiting");
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdownLEDs();
  process.exit(0);
});
