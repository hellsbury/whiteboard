# whiteboard

real-time collaborative whiteboard to manage our projects

## Getting Started

You need a compiler for the [Zig Programming Language](https://github.com/ziglang/zig/releases), and
a web browser. Required version: 0.13.0.

To run the project, execute `zig build`, and then execute the binary in `./zig-out/bin/whiteboard.`
You can now visit the application at `http://localhost:8000`.

## Architecture

The server is contained in `./src/main.zig`. It starts up a websocket connection that clients
connect to when the HTML file loads. All communication is done via RPC communication over this web
socket.

The client/server architecture is basically just "distributed Redux", if you're familiar with the
Flux/Redux architecture from React etc: Each client renders the page based on a single state object.
When a client mutates this state (for example, someone drags a card around), a websocket message is
posted to the server, which then broadcasts a state update message to all clients. Each client
(including the one that originally made the change) then updates their own local copy of the state
in response to the message.

There is no authentication or authorization. This can be implemented by a proxy server if desired.

## References

- [WebSocket Spec](https://www.rfc-editor.org/rfc/rfc6455)
- [WebSockets - Mozilla](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers)
- [Zig HTTP Module](https://ziglang.org/documentation/master/std/#std.http)
