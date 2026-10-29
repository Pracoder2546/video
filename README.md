# Video Chat

Rooms of up to 4 people. Waits for 2, then connects; 3rd and 4th join the same room; the 5th waits for the 6th, 7th and 8th.

## Run locally
    pip install -r requirements.txt
    python app.py
Open http://localhost:8000 (camera/mic work on localhost). Open it in 2+ tabs to test.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render -> New -> Web Service (or Blueprint, it reads render.yaml).
3. Build command: `pip install -r requirements.txt`  Start command: `python app.py`
Render gives you HTTPS automatically, which browsers require for camera/mic.

## Optional: TURN server
Some strict networks need a TURN relay. Set env var ICE_SERVERS to JSON, e.g.
[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your.turn.host:3478","username":"u","credential":"p"}]
