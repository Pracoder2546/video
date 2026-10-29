const startScreen = document.getElementById("start-screen");
const chatScreen = document.getElementById("chat-screen");
const nickInput = document.getElementById("nick-input");
const startBtn = document.getElementById("start-btn");
const startError = document.getElementById("start-error");
const leaveBtn = document.getElementById("leave-btn");
const statusEl = document.getElementById("status");
const grid = document.getElementById("video-grid");
const messages = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let ws = null;
let localStream = null;
let myId = null;
let myNick = "";
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const peers = {}; // id -> { pc, nick, tile, pending: [] }

nickInput.value = localStorage.getItem("nick") || "";

startBtn.addEventListener("click", start);
nickInput.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
leaveBtn.addEventListener("click", leave);

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "chat", text }));
  chatInput.value = "";
});

async function start() {
  const nick = nickInput.value.trim();
  if (!nick) {
    startError.textContent = "Please enter a nickname.";
    return;
  }
  startError.textContent = "";
  startBtn.disabled = true;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    startError.textContent = "Camera and microphone access is required.";
    startBtn.disabled = false;
    return;
  }

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
  addTile("local", "You (" + nick + ")", localStream, true);
  setStatus("Waiting for someone to join…");

  connectSocket();
}

function connectSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/ws");

  ws.onopen = () => ws.send(JSON.stringify({ type: "join", nick: myNick }));

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "welcome") {
      myId = msg.id;
      // We are the newcomer: send an offer to everyone already in the room
      for (const p of msg.peers) {
        await createPeer(p.id, p.nick, true);
      }
      updateStatus();
    } else if (msg.type === "peer-joined") {
      // Existing member: wait for the newcomer's offer
      addSystem(msg.nick + " joined");
      await createPeer(msg.id, msg.nick, false);
      updateStatus();
    } else if (msg.type === "peer-left") {
      const p = peers[msg.id];
      if (p) addSystem(p.nick + " left");
      removePeer(msg.id);
      updateStatus();
    } else if (msg.type === "signal") {
      await handleSignal(msg.from, msg.data);
    } else if (msg.type === "chat") {
      addChat(msg.nick, msg.text, msg.id === myId);
    }
  };

  ws.onclose = () => {
    if (localStream) setStatus("Disconnected from server.");
  };
}

async function createPeer(id, nick, initiator) {
  if (peers[id]) return peers[id];

  const pc = new RTCPeerConnection({ iceServers });
  const peer = { pc, nick, tile: null, pending: [] };
  peers[id] = peer;

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(id, { candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    if (!peer.tile) peer.tile = addTile(id, nick, e.streams[0], false);
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
  if (!peer) peer = await createPeer(from, "Guest", false);
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
  if (!peer) return;
  peer.pc.close();
  if (peer.tile) peer.tile.remove();
  delete peers[id];
  updateGrid();
}

function addTile(id, label, stream, isLocal) {
  const tile = document.createElement("div");
  tile.className = "tile" + (isLocal ? " local" : "");
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal; // never hear yourself
  video.srcObject = stream;
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = label;
  tile.append(video, name);
  grid.appendChild(tile);
  updateGrid();
  return tile;
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
  grid.innerHTML = "";
  chatScreen.classList.add("hidden");
  startScreen.classList.remove("hidden");
  startBtn.disabled = false;
}

window.addEventListener("beforeunload", () => { if (ws) ws.close(); });
