from fastapi import WebSocket


class Broadcaster:
    def __init__(self):
        self.connections: set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.add(ws)

    def disconnect(self, ws: WebSocket):
        self.connections.discard(ws)

    async def broadcast(self, msg: str):
        to_remove = []
        for ws in list(self.connections):
            try:
                await ws.send_text(msg)
            except Exception:
                to_remove.append(ws)
        for ws in to_remove:
            self.disconnect(ws)

# singleton instance
broadcaster = Broadcaster()
