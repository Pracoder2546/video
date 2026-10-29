import json
import os
import uuid
from pathlib import Path

from aiohttp import WSMsgType, web

BASE_DIR = Path(__file__).parent
MAX_ROOM_SIZE = 4

# room_id -> {"id": str, "members": {peer_id: {"ws": WebSocketResponse, "nick": str}}}
rooms = {}


def pick_room():
    """Matching rules:
    1. Fill rooms that already have 2-3 people (up to 4).
    2. Otherwise join a room where someone is waiting alone (so they get connected).
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
                room = pick_room()
                me = {"ws": ws, "nick": nick}
                existing = [
                    {"id": pid, "nick": m["nick"]} for pid, m in room["members"].items()
                ]
                room["members"][peer_id] = me
                # Tell the new person who is already here (they will send the offers)
                await send(me, {"type": "welcome", "id": peer_id, "peers": existing})
                # Tell everyone else somebody joined
                await broadcast(
                    room,
                    {"type": "peer-joined", "id": peer_id, "nick": nick},
                    exclude=peer_id,
                )

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
