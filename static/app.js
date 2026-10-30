const startScreen = document.getElementById("start-screen");
const chatScreen = document.getElementById("chat-screen");
const nickInput = document.getElementById("nick-input");
const startBtn = document.getElementById("start-btn");
const startError = document.getElementById("start-error");
const leaveBtn = document.getElementById("leave-btn");
const camBtn = document.getElementById("cam-btn");
const statusEl = document.getElementById("status");
const grid = document.getElementById("video-grid");
const messages = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let ws = null;
let localStream = null;
let hasVideo = false;
let hasAudio = false;
let camOn = false;
let myId = null;
let myNick = "";
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const peers = {}; // id -> { pc, nick, tile, pending: [] }
const tiles = {}; // id -> { el, video, avatar }

nickInput.value = localStorage.getItem("nick") || "";

startBtn.addEventListener("click", start);
nickInput.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
leaveBtn.addEventListener("click", leave);
camBtn.addEventListener("click", toggleCamera);

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "chat", text }));
  chatInput.value = "";
});

// Try camera+mic, then camera only, then mic only, then nothing (chat only)
async function getMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  const attempts = [
    { video: true, audio: true },
    { video: true, audio: false },
    { video: false, audio: true },
  ];
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) { /* try the next option */ }
  }
  return null;
}

async function start() {
  const nick = nickInput.value.trim();
  if (!nick) {
    startError.textContent = "Please enter a nickname.";
    return;
  }
  startError.textContent = "";
  startBtn.disabled = true;

  localStream = await getMedia();
  hasVideo = !!localStream && localStream.getVideoTracks().length > 0;
  hasAudio = !!localStream && localStream.getAudioTracks().length > 0;
  camOn = hasVideo;

  try {
    const res = await fetch("/config");
    const cfg = await res.json();
    if (cfg.iceServers) iceServers = cfg.iceServers;
  } catch (_) { /* use default STUN */ }

  myNick = nick;
  localStorage.setItem("nick", nick);

  startScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  messages.innerHTML = "";
  grid.innerHTML = "";

  addTile("local", "You (" + nick + ")", localStream, true, camOn);
  camBtn.classList.toggle("hidden", !hasVideo);
  updateCamButton();

  if (!hasVideo && !hasAudio) {
    addSystem("No camera or microphone found. You joined in chat-only mode.");
  } else if (!hasVideo) {
    addSystem("No camera found. Others will see your name only.");
  } else if (!hasAudio) {
    addSystem("No microphone found. Others can see you but not hear you.");
  }
  setStatus("Waiting for someone to join…");

  connectSocket();
}

function connectSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/ws");

  ws.onopen = () => ws.send(JSON.stringify({ type: "join", nick: myNick, cam: camOn }));

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "welcome") {
      myId = msg.id;
      // We are the newcomer: send an offer to everyone already in the room
      for (const p of msg.peers) {
        await createPeer(p.id, p.nick, p.cam, true);
      }
      updateStatus();
    } else if (msg.type === "peer-joined") {
      addSystem(msg.nick + " joined");
      await createPeer(msg.id, msg.nick, msg.cam, false);
      updateStatus();
    } else if (msg.type === "peer-left") {
      const p = peers[msg.id];
      if (p) addSystem(p.nick + " left");
      removePeer(msg.id);
      updateStatus();
    } else if (msg.type === "cam") {
      setTileCam(msg.id, msg.on);
    } else if (msg.type === "signal") {
      await handleSignal(msg.from, msg.data);
    } else if (msg.type === "chat") {
      addChat(msg.nick, msg.text, msg.id === myId);
    }
  };

  ws.onclose = () => {
    if (chatScreen.classList.contains("hidden")) return;
    setStatus("Disconnected from server.");
  };
}

async function createPeer(id, nick, cam, initiator) {
  if (peers[id]) return peers[id];

  const pc = new RTCPeerConnection({ iceServers });
  const peer = { pc, nick, pending: [] };
  peers[id] = peer;

  // Show the person right away (their name shows if they have no camera)
  addTile(id, nick, null, false, !!cam);

  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  // If we have no camera/mic, still ask to receive theirs
  if (initiator) {
    if (!hasVideo) pc.addTransceiver("video", { direction: "recvonly" });
    if (!hasAudio) pc.addTransceiver("audio", { direction: "recvonly" });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(id, { candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    const t = tiles[id];
    if (t && e.streams[0] && t.video.srcObject !== e.streams[0]) {
      t.video.srcObject = e.streams[0];
    }
  };

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(id, { sdp: pc.localDescription });
  }
  return peer;
}

async function handleSignal(from, data) {
  let peer = peers[from];
  if (!peer) peer = await createPeer(from, "Guest", false, false);
  const pc = peer.pc;

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    for (const c of peer.pending) await pc.addIceCandidate(c).catch(() => {});
    peer.pending = [];
    if (data.sdp.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { sdp: pc.localDescription });
    }
  } else if (data.candidate) {
    const candidate = new RTCIceCandidate(data.candidate);
    if (pc.remoteDescription) await pc.addIceCandidate(candidate).catch(() => {});
    else peer.pending.push(candidate);
  }
}

function sendSignal(to, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "signal", to, data }));
  }
}

function removePeer(id) {
  const peer = peers[id];
  if (peer) {
    peer.pc.close();
    delete peers[id];
  }
  if (tiles[id]) {
    tiles[id].el.remove();
    delete tiles[id];
  }
  updateGrid();
}

function addTile(id, label, stream, isLocal, cam) {
  const el = document.createElement("div");
  el.className = "tile" + (isLocal ? " local" : "");

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal; // never hear yourself
  if (stream) video.srcObject = stream;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = label;

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = label;

  el.append(video, avatar, name);
  grid.appendChild(el);
  tiles[id] = { el, video, avatar };
  setTileCam(id, cam);
  updateGrid();
}

function setTileCam(id, on) {
  const t = tiles[id];
  if (t) t.el.classList.toggle("cam-off", !on);
}

function toggleCamera() {
  if (!hasVideo || !localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => { t.enabled = camOn; });
  setTileCam("local", camOn);
  updateCamButton();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "cam", on: camOn }));
  }
}

function updateCamButton() {
  camBtn.textContent = camOn ? "Camera: On" : "Camera: Off";
  camBtn.classList.toggle("off", !camOn);
}

function updateGrid() {
  grid.dataset.count = grid.children.length;
}

function updateStatus() {
  const n = Object.keys(peers).length;
  if (n === 0) setStatus("Waiting for someone to join…");
  else setStatus("Connected with " + n + " other" + (n > 1 ? "s" : "") + " (" + (n + 1) + "/4)");
}

function setStatus(text) { statusEl.textContent = text; }

function addChat(nick, text, mine) {
  const div = document.createElement("div");
  div.className = "msg" + (mine ? " me" : "");
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = nick + ": ";
  const body = document.createElement("span");
  body.textContent = text;
  div.append(who, body);
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function addSystem(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function leave() {
  Object.keys(peers).forEach(removePeer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  myId = null;
  hasVideo = hasAudio = camOn = false;
  Object.keys(tiles).forEach((k) => delete tiles[k]);
  grid.innerHTML = "";
  chatScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
  startBtn.disabled = false;
}

window.addEventListener("beforeunload", () => { if (ws) ws.close(); });
