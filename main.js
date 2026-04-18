const dgram = require("dgram");
const HID = require("node-hid");

// ===== CONFIG =====
const UDP_PORT = 20777;

const VENDOR_ID = 0x046d;
const PRODUCT_ID = 0xc24f;

// ===== STATE =====
let device;
let previousMask = -1;
let idleRpm = 0;
let maxRpm = 0;

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

// ===== DIRECT LED LOGIC (NO SMOOTHING) =====
function updateLEDs(rpm) {
  if (maxRpm === 0) return; // no status packet received yet

  // map rpm to 0.0-1.0 within the usable range (idle to max)
  const range = maxRpm - idleRpm;
  const frac = Math.max(0, (rpm - idleRpm) / range);

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

    updateLEDs(rpm);
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
