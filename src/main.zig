const std = @import("std");
const ws = @import("./websocket.zig");
const builtin = @import("builtin");

const Request = std.http.Server.Request;

fn prettyPrintClientAddr(prefix: []const u8, addr: std.net.Address) !void {
    const stderr = std.io.getStdErr().writer();
    var bw = std.io.bufferedWriter(stderr);
    const writer = bw.writer();

    try writer.writeAll(prefix);
    try addr.format("", .{}, writer);
    try writer.writeByte('\n');
    try bw.flush();
}

fn mimeTypeForFileName(file: []const u8) []const u8 {
    if (std.mem.endsWith(u8, file, ".html")) {
        return "text/html";
    } else if (std.mem.endsWith(u8, file, ".css")) {
        return "text/css";
    } else if (std.mem.endsWith(u8, file, ".js")) {
        return "text/javascript";
    }

    return "text/plain";
}

fn defaultHandler(allocator: std.mem.Allocator, request: *Request) !void {
    // read the path from the request
    var file_name: []const u8 = undefined;
    if (std.mem.eql(u8, request.head.target, "/")) {
        file_name = "index.html";
    } else {
        file_name = request.head.target[1..]; // trim leading slash
    }

    const final_file_name = try std.mem.concat(allocator, u8, &[_][]const u8{ "www", "/", file_name });
    defer allocator.free(final_file_name);

    var file = std.fs.cwd().openFile(final_file_name, .{}) catch {
        try request.respond("Not Found", .{
            .status = std.http.Status.not_found,
        });
        return;
    };

    const contents = try file.readToEndAlloc(allocator, 1 << 20);
    try request.respond(contents, .{
        .extra_headers = &.{.{ .name = "content-type", .value = mimeTypeForFileName(file_name) }},
    });
}

fn handleWsConversation(allocator: std.mem.Allocator, conn: std.net.Server.Connection) !void {
    try prettyPrintClientAddr("starting new websocket communication with ", conn.address);

    const conn_reader = conn.stream.reader();
    const conn_writer = conn.stream.writer();
    const message_reader = ws.MessageReader(@TypeOf(conn_reader));
    const message_writer = ws.FrameWriter(@TypeOf(conn_writer));

    // assuming that pinging the client for liveness checks is currently unecessary.
    while (true) {
        const message = message_reader.readMessage(allocator, conn_reader, 1 << 20) catch |err| switch (err) {
            ws.ReadError.EndOfStream => {
                try prettyPrintClientAddr("client closed connection ", conn.address);
                break;
            },
            else => {
                std.log.err("encountered unexpected error reading websocket message: {any}", .{err});
                break;
            },
        };
        defer message.deinit();

        if (message.opcode == ws.Opcode.connection_close) {
            std.log.info("received close opcode", .{});
            try message_writer.writeFrame(conn_writer, "", true, ws.Opcode.connection_close);
            break;
        }

        if (message.opcode == ws.Opcode.ping) {
            try message_writer.writeFrame(conn_writer, message.data, true, ws.Opcode.pong);
        }

        // otherwise we received some arbitrary message for our application,
        // which we will assume to be a utf-8 string:
        std.log.info("received application message from client: '{s}'", .{message.data});
        try message_writer.writeFrame(conn_writer, "hello from the server", true, ws.Opcode.text);
    }

    // not closing stream here, because we will be closed by the main http handler
}

fn websocketUpgradeHandler(
    allocator: std.mem.Allocator,
    request: *Request,
    conn: std.net.Server.Connection,
) !void {
    const client_hs = ws.ClientHandshake.tryParse(request) orelse {
        try request.respond("invalid request, expected websocket handshake", .{
            .status = std.http.Status.bad_request,
        });

        return;
    };

    // otherwise we consider this to be a valid connection
    try ws.replyHandshakeSuccess(allocator, client_hs, request);
    try handleWsConversation(allocator, conn);
}

fn handleConnection(conn: std.net.Server.Connection, allocator: std.mem.Allocator) !void {
    try prettyPrintClientAddr("received new http connection from ", conn.address);

    var read_buffer: [1024]u8 = undefined;
    var server = std.http.Server.init(conn, &read_buffer);

    while (true) {
        var request = server.receiveHead() catch |err| switch (err) {
            std.http.Server.ReceiveHeadError.HttpConnectionClosing => return,
            else => {
                std.log.err("error receiving head: {s}", .{@errorName(err)});
                return;
            },
        };

        std.log.info("request: {s} {s}", .{ @tagName(request.head.method), request.head.target });
        if (std.mem.eql(u8, request.head.target, "/connect")) {
            try websocketUpgradeHandler(allocator, &request, conn);
            break;
        } else {
            try defaultHandler(allocator, &request);
        }

        if (!request.head.keep_alive) {
            break;
        }
    }

    conn.stream.close();
}

const port: u16 = 8000;

pub fn main() !void {
    // TODO: consider other methods of allocation (arena per connection?)
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const addr = try std.net.Address.resolveIp("127.0.0.1", port);
    var server = try addr.listen(.{ .reuse_address = true });

    std.log.info("starting server at 127.0.0.1:{d}", .{port});
    while (true) {
        // TODO: some kind of graceful shutdown?
        const conn = try server.accept();
        _ = try std.Thread.spawn(.{}, handleConnection, .{ conn, allocator });
    }
}

test {
    _ = ws;
}
