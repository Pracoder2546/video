import asyncio
import json
import os
import uuid
from pathlib import Path

import aiohttp
from aiohttp import WSMsgType, web

BASE_DIR = Path(__file__).parent
MAX_ROOM_SIZE = 4

# room_id -> {"id": str, "members": {peer_id: {"ws": ws, "nick": str, "cam": bool}}}
rooms = {}
background_tasks = set()


def pick_room():
    """Matching rules:
    1. Fill rooms that already have 2-3 people (up to 4).
    2. Otherwise join a room where someone is waiting alone.
    3. Otherwise open a new room and wait.
    """
    for room in rooms.values():
        if 2 <= len(room["members"]) < MAX_ROOM_SIZE:
            return room
    for room in rooms.values():
        if len(room["members"]) == 1:
            return room
    room = {"id": uuid.uuid4().hex[:8], "members": {}}
    rooms[room["id"]] = room
    return room


def online_count():
    return sum(len(r["members"]) for r in rooms.values())


async def notify(nick, site_url, online):
    """Send an alert to the site owner. Configure with env vars:
    NTFY_TOPIC (free push notifications via ntfy.sh) and/or DISCORD_WEBHOOK_URL.
    """
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    hook = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if not topic and not hook:
        return

    if online <= 1:
        text = nick + " just joined Video Chat and is waiting alone. Join them!"
    else:
        text = nick + " just joined Video Chat. " + str(online) + " people online. Join them!"

    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            if topic:
                server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
                await session.post(
                    server + "/" + topic,
                    data=text.encode("utf-8"),
                    headers={
                        "Title": "Someone joined Video Chat",
                        "Click": site_url,
                        "Tags": "video_camera",
                        "Priority": "high",
                    },
                )
            if hook:
                await session.post(hook, json={"content": text + " " + site_url})
    except Exception as exc:
        print("Notification failed:", exc)


def fire_notify(nick, site_url, online):
    task = asyncio.create_task(notify(nick, site_url, online))
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)


async def send(member, payload):
    try:
        await member["ws"].send_str(json.dumps(payload))
    except Exception:
        pass


async def broadcast(room, payload, exclude=None):
    for pid, member in list(room["members"].items()):
        if pid != exclude:
            await send(member, payload)


def clean_nick(value):
    nick = str(value or "").strip()[:20]
    return nick or "Guest"


def site_url_for(request):
    configured = os.environ.get("SITE_URL", "").strip()
    if configured:
        return configured
    host = request.headers.get("X-Forwarded-Host") or request.host
    scheme = request.headers.get("X-Forwarded-Proto") or request.scheme
    return scheme + "://" + host


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=2**20)
    await ws.prepare(request)

    peer_id = uuid.uuid4().hex[:10]
    room = None

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except ValueError:
                continue

            kind = data.get("type")

            if kind == "join" and room is None:
                nick = clean_nick(data.get("nick"))
                cam = bool(data.get("cam", False))
                room = pick_room()
                me = {"ws": ws, "nick": nick, "cam": cam}
                existing = [
                    {"id": pid, "nick": m["nick"], "cam": m["cam"]}
                    for pid, m in room["members"].items()
                ]
                room["members"][peer_id] = me
                await send(me, {"type": "welcome", "id": peer_id, "peers": existing})
                await broadcast(
                    room,
                    {"type": "peer-joined", "id": peer_id, "nick": nick, "cam": cam},
                    exclude=peer_id,
                )
                fire_notify(nick, site_url_for(request), online_count())

            elif kind == "cam" and room is not None:
                on = bool(data.get("on"))
                room["members"][peer_id]["cam"] = on
                await broadcast(room, {"type": "cam", "id": peer_id, "on": on}, exclude=peer_id)

            elif kind == "signal" and room is not None:
                target = room["members"].get(data.get("to"))
                if target:
                    await send(
                        target,
                        {"type": "signal", "from": peer_id, "data": data.get("data")},
                    )

            elif kind == "chat" and room is not None:
                text = str(data.get("text", "")).strip()[:500]
                if text:
                    await broadcast(
                        room,
                        {
                            "type": "chat",
                            "id": peer_id,
                            "nick": room["members"][peer_id]["nick"],
                            "text": text,
                        },
                    )
    finally:
        if room is not None:
            room["members"].pop(peer_id, None)
            if room["members"]:
                await broadcast(room, {"type": "peer-left", "id": peer_id})
            else:
                rooms.pop(room["id"], None)

    return ws


async def config_handler(request):
    default = [{"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}]
    try:
        ice = json.loads(os.environ.get("ICE_SERVERS", ""))
    except ValueError:
        ice = default
    return web.json_response({"iceServers": ice or default})


async def index_handler(request):
    return web.FileResponse(BASE_DIR / "static" / "index.html")


def create_app():
    app = web.Application()
    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/config", config_handler)
    app.router.add_static("/static", BASE_DIR / "static")
    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    web.run_app(create_app(), host="0.0.0.0", port=port)
