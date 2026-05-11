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

const FLASH_INTERVAL = 50; // ms between on/off toggles (~10Hz)
const TELEMETRY_TIMEOUT = 2000; // ms without telemetry before turning off LEDs

const BEEP_FREQ = 3000; // Hz
const BEEP_DURATION = 0.4; // seconds
// ===== STATE =====
let device;
let previousMask = -1;
let flashTimer = null;
let flashOn = false;
let telemetryWatchdog = null;
let hasBeepedThisShift = false;
let previousGear = -1;
let beepArmed = false; // only arm after an upshift

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

// ===== STARTUP ANIMATION =====
function playStartupAnimation() {
  if (!device) return;

  const leds = [0x01, 0x02, 0x04, 0x08, 0x10];
  const delay = 80; // ms between steps
  let step = 0;
  let mask = 0x00;

  setTimeout(() => {
    const timer = setInterval(() => {
      if (step < leds.length) {
        // sweep on: left to right
        mask |= leds[step];
        writeLED(mask);
      } else if (step < leds.length * 2) {
        // sweep off: left to right
        mask &= ~leds[step - leds.length];
        writeLED(mask);
      } else {
        // done
        clearInterval(timer);
        writeLED(0x00);
        previousMask = -1;
        console.log("🔄 Startup animation complete");
      }
      step++;
    }, delay);
  }, 300); // small delay ensures HID is ready
}

// ===== CLEANUP =====
function shutdownLEDs() {
  stopFlashing();
  writeLED(0x00);
  previousMask = -1;
  previousGear = -1;
  hasBeepedThisShift = false;
  beepArmed = false;
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
  writeLED(0x1f); // immediately all-on, no gap
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
  previousMask = -1; // force next writeLED since flash may have left LEDs in unknown state
}

// ===== DIRECT LED LOGIC (NO SMOOTHING) =====
function updateLEDs(rpm, revLightsPercent) {
  // flash all LEDs at shift point (use game's per-gear rev lights)
  // hysteresis: start flashing at 95%, only stop below 85%
  if (revLightsPercent >= 95 || (flashTimer && revLightsPercent >= 85)) {
    startFlashing();
    if (!hasBeepedThisShift && beepArmed) {
      playBeep();
      hasBeepedThisShift = true;
    }
    return;
  }

  stopFlashing();

  // progressive LEDs based on game's per-gear rev lights percentage
  let mask = 0x00;

  if (revLightsPercent > 5) mask |= 0x01;
  if (revLightsPercent > 25) mask |= 0x02;
  if (revLightsPercent > 50) mask |= 0x04;
  if (revLightsPercent > 75) mask |= 0x08;
  if (revLightsPercent > 90) mask |= 0x10;

  // only send if changed (prevents USB spam)
  if (mask !== previousMask) {
    previousMask = mask;
    writeLED(mask);

    console.log(
      `RPM: ${rpm} | rev: ${revLightsPercent}% | mask: ${mask.toString(2).padStart(5, "0")}`,
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

    // Car Telemetry packet (ID 6)
    if (packetId !== 6) return;

    const TELEMETRY_CAR_SIZE = 60;
    const base = 24 + playerIndex * TELEMETRY_CAR_SIZE;

    const rpm = msg.readUInt16LE(base + 16);
    if (rpm <= 0 || rpm > 20000) return;

    const revLightsPercent = msg.readUInt8(base + 19);

    const gear = msg.readInt8(base + 15);
    if (previousGear >= 0 && gear > previousGear) {
      hasBeepedThisShift = false;
      beepArmed = true; // only beep after a real upshift
    } else if (gear < previousGear) {
      beepArmed = false; // suppress beep on downshift RPM spikes
    }
    previousGear = gear;

    updateLEDs(rpm, revLightsPercent);
    resetWatchdog();
  } catch (err) {
    console.log("Packet error:", err.message);
  }
}

// ===== START =====
connectWheel();

playStartupAnimation();

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
