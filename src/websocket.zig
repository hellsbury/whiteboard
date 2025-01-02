/// websocket.zig -- basic utilities for reading and writing websocket protocol
/// messages to and from a TCP connection
///
/// Notes:
///   - Does not support extensions
///   - Does not validate extension reserved header bits
///   - Does not support Sec-WebSocket-Protocol (clients can pass it, but we will
///     not validate it, or do anything with it)
///   - Does not support interleaving control frames with fragmented message
///     frames, allow this is allowed by the protocol specification.
///   - Does not validate client masking, but does perform unmasking if a masking
///     key is provided
///   - Writing masked payloads is not supported, as this is only inteded to work
///     in a server side environment
const std = @import("std");

//-------------------------------------------------------------------------------------------------
// Protocol Implementation
//-------------------------------------------------------------------------------------------------

/// Represents the possible websocket frame opcodes.
/// See https://www.rfc-editor.org/rfc/rfc6455#section-5.2
pub const Opcode = enum(u4) {
    // basic opcode types:
    continuation = 0x0,
    text = 0x1,
    binary = 0x2,

    // reserved non-control frames:
    rsv_non_control_1 = 0x3,
    rsv_non_control_2 = 0x4,
    rsv_non_control_3 = 0x5,
    rsv_non_control_4 = 0x6,
    rsv_non_control_5 = 0x7,

    // control frames:
    connection_close = 0x8,
    ping = 0x9,
    pong = 0xA,

    // reserved control frames:
    rsv_control_1 = 0xB,
    rsv_control_2 = 0xC,
    rsv_control_3 = 0xD,
    rsv_control_4 = 0xE,
    rsv_control_5 = 0xF,
};

pub const ReadError = error{
    EndOfStream,
    InvalidFragmentOpcode,
    FragmentedMessageTooLong,
};

pub fn MessageReader(comptime ReaderType: type) type {
    const frame_reader = FrameReader(ReaderType);

    return struct {
        opcode: Opcode,
        data: []const u8,
        allocator: std.mem.Allocator,

        const Self = @This();
        pub const Error = frame_reader.Error;

        /// Reads and parses as many frames as it takes to read a full message, up to
        /// max_len. Returns a buffer owned by the allocator.  The caller is expected to
        /// free this buffer when it is done with it.  If max_len is reached before the
        /// last fragment is read, an error is returned.
        pub fn readMessage(
            allocator: std.mem.Allocator,
            reader: ReaderType,
            max_len: usize,
        ) Error!Self {
            var frame = try frame_reader.readFrame(allocator, reader);
            const opcode = frame.opcode;

            // fast first-case: the whole message is in the first frame:
            if (frame.fin) {
                return .{
                    .data = frame.payload,
                    .opcode = opcode,
                    .allocator = allocator,
                };
            }

            // otherwise loop through the remaining fragments until we get a full message
            var payload_buf = std.ArrayList(u8).fromOwnedSlice(allocator, @constCast(frame.payload));
            while (!frame.fin) {
                frame = try frame_reader.readFrame(allocator, reader);
                // See https://www.rfc-editor.org/rfc/rfc6455#section-5.4
                if (frame.opcode != Opcode.continuation) {
                    // the specification allows sending control frames here, but
                    // we are going to require clients not to do this.  this is
                    // fine for our use case, as we only want to send relatively
                    // small JSON fragments over the wire.
                    return ReadError.InvalidFragmentOpcode;
                }

                if (payload_buf.items.len + frame.payload.len > max_len) {
                    return ReadError.FragmentedMessageTooLong;
                }

                // we're going to copy the bytes from the next frames into payload_buf,
                // so we need to free the temporary frame buffers
                defer frame.deinit();
                try payload_buf.appendSlice(frame.payload);
            }

            return .{
                .data = try payload_buf.toOwnedSlice(),
                .opcode = opcode,
                .allocator = allocator,
            };
        }

        pub fn deinit(self: *const Self) void {
            self.allocator.free(self.data);
        }
    };
}

/// Reads a single websocket frame from a io.Reader
pub fn FrameReader(comptime ReaderType: type) type {
    return struct {
        fin: bool,
        opcode: Opcode,
        length: usize,
        payload: []const u8,
        allocator: std.mem.Allocator,

        const Self = @This();

        pub const Error = ReadError || ReaderType.Error || std.mem.Allocator.Error;

        /// Reads and parses a frame, allocating the payload with the provided
        /// allocator.  The caller is expected to call deinit() on the frame as
        /// soon as it is done with it.
        pub fn readFrame(allocator: std.mem.Allocator, reader: ReaderType) Error!Self {
            var _buf_reader = std.io.bufferedReader(reader);
            const buf_reader = _buf_reader.reader();

            var cursor: u32 = 0;
            // 14 bytes is the maximum length of the header
            var header_buf: [14]u8 = undefined;

            // read the first byte to determine the opcode, and first length byte
            try readAtLeastOrThrow(buf_reader, header_buf[0..2], 2);
            cursor += 2;

            const fin = (header_buf[0] & (1 << 7)) != 0;
            const opcode: u4 = @intCast(header_buf[0] & 0x0F);

            // read the length bytes
            const is_payload_masked = header_buf[1] & (1 << 7) != 0;
            const length_meta = try determinePayloadLength(buf_reader, header_buf[1]);

            var masking_key: ?[]u8 = null;
            cursor += length_meta.advance_cursor;

            // if there's a mask, read the 4 bytes for that
            if (is_payload_masked) {
                try readAtLeastOrThrow(buf_reader, header_buf[cursor .. cursor + 4], 4);
                // note that we do not have to convert to native endianness
                // because the masking key isn't a real number, it's just
                // 4 bytes
                masking_key = header_buf[cursor .. cursor + 4];
                cursor += 4;
            }

            // then read the payload, if there is one
            var payload: []u8 = &.{};
            if (length_meta.length != 0) {
                payload = try allocator.alloc(u8, length_meta.length);
                try readAtLeastOrThrow(buf_reader, payload, length_meta.length);
            }

            // then unmask the payload, if there's a mask and a payload
            if (is_payload_masked and payload.len > 0) {
                for (payload, 0..) |c, i| {
                    payload[i] = c ^ masking_key.?[i % 4];
                }
            }

            return .{
                .fin = fin,
                .opcode = @enumFromInt(opcode),
                .length = length_meta.length,
                .payload = payload,
                .allocator = allocator,
            };
        }

        /// De-initializes the frame, freeing the payload that was allocated
        /// during `read_frame`
        pub fn deinit(self: *const Self) void {
            self.allocator.free(self.payload);
        }
    };
}

/// Writes a single websocket frame to an io.Writer
pub fn FrameWriter(comptime WriterType: type) type {
    return struct {
        pub fn writeFrame(
            writer: WriterType,
            payload: []const u8,
            fin: bool,
            opcode: Opcode,
        ) !void {
            var _buf_writer = std.io.bufferedWriter(writer);
            const buf_writer = _buf_writer.writer();

            var first_byte: u8 = 0;
            if (fin) {
                first_byte |= 1 << 7;
            }

            // leave the rsv bits to 0, because we don't support extensions

            const opcode_int: u8 = @intFromEnum(opcode);
            first_byte = (first_byte & 0xF0) | (opcode_int & 0x0F);

            // masking bit is always turned off, so we don't have to explicitly set it, as we
            // never write more than 127 to the first byte of length_buf
            var length_buf: [9]u8 = undefined; // max buffer
            var length: []u8 = &.{}; // real buffer we'll write to the stream
            if (payload.len <= 125) {
                length_buf[0] = @intCast(payload.len);
                length = length_buf[0..1];
            } else if (payload.len <= std.math.maxInt(u16)) {
                std.mem.writeInt(u16, length_buf[1..3], @as(u16, @intCast(payload.len)), .big);
                length_buf[0] = 126;
                length = length_buf[0..3];
            } else {
                std.mem.writeInt(u64, length_buf[1..9], @as(u64, @intCast(payload.len)), .big);
                length_buf[0] = 127;
                length = length_buf[0..9];
            }

            try buf_writer.writeByte(first_byte);
            try buf_writer.writeAll(length);
            try buf_writer.writeAll(payload);
            try _buf_writer.flush();
        }
    };
}

//-------------------------------------------------------------------------------------------------
// Handshake & Lifecycle Management
//-------------------------------------------------------------------------------------------------

const ws_magic_str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Calculates the value that should go into the `Sec-WebSocket-Accept` header
/// to upgrade an HTTP connection to a websocket connection
fn generateWebSocketAccept(allocator: std.mem.Allocator, client_key: []const u8) ![]const u8 {
    const concat_result = try std.mem.concat(
        allocator,
        u8,
        &[_][]const u8{ client_key, ws_magic_str },
    );
    const Hasher = std.crypto.hash.Sha1;
    const out = try allocator.alloc(u8, Hasher.digest_length);
    Hasher.hash(concat_result, @ptrCast(out.ptr), .{});
    defer allocator.free(out);

    const encoder = std.base64.standard.Encoder;
    const encoded = try allocator.alloc(u8, encoder.calcSize(out.len));
    return encoder.encode(encoded, out);
}

const Request = std.http.Server.Request;

pub const ClientHandshake = struct {
    // Contents of the Sec-WebSocket-Key header
    key: []const u8,

    // Determines whether a given std.http.Server.Request is a valid start to a
    // client handshake. If it is, returns the components that are required to
    // produce a RespondOptions for the server upgrade response.
    pub fn tryParse(request: *Request) ?ClientHandshake {
        // the request MUST contain a "Connection: Upgrade" header, a
        // Sec-Websocket-Key, and a "Upgrade" header whose value must
        // _include_ "websocket"
        var has_conn_upgrade = false;
        var has_upgrade_websocket = false;
        var websocket_key: ?[]const u8 = null;
        var requirements_complete = false;
        var websocket_version_ok = false;

        // https://datatracker.ietf.org/doc/html/rfc6455#section-4.2.1
        var it = request.iterateHeaders();
        while (it.next()) |header| {
            if (std.ascii.eqlIgnoreCase(header.name, "connection") and std.mem.indexOf(u8, header.value, "Upgrade") != null) {
                has_conn_upgrade = true;
            }

            if (std.ascii.eqlIgnoreCase(header.name, "upgrade") and std.mem.indexOf(u8, header.value, "websocket") != null) {
                has_upgrade_websocket = true;
            }

            if (std.ascii.eqlIgnoreCase(header.name, "sec-websocket-version") and std.mem.eql(u8, header.value, "13")) {
                websocket_version_ok = true;
            }

            if (std.ascii.eqlIgnoreCase(header.name, "sec-websocket-key")) {
                websocket_key = header.value;
            }

            if (has_conn_upgrade and has_upgrade_websocket and websocket_version_ok and websocket_key != null) {
                requirements_complete = true;
                break;
            }
        }

        if (!requirements_complete) return null;

        return .{
            .key = websocket_key.?,
        };
    }
};

pub fn replyHandshakeSuccess(allocator: std.mem.Allocator, client_hs: ClientHandshake, request: *Request) !void {
    const hs_key = try generateWebSocketAccept(allocator, client_hs.key);
    defer allocator.free(hs_key);

    try request.respond("", .{
        .status = std.http.Status.switching_protocols,
        .extra_headers = &.{
            .{ .name = "Upgrade", .value = "websocket" },
            .{ .name = "Connection", .value = "Upgrade" },
            .{ .name = "Sec-WebSocket-Accept", .value = hs_key },
        },
    });
}

//-------------------------------------------------------------------------------------------------
// Private Utilities
//-------------------------------------------------------------------------------------------------

const LengthMeta = struct {
    // the actual payload length
    length: u64,
    // the amount to advance the frame reader buf cursor by
    advance_cursor: u32,
};

fn determinePayloadLength(reader: anytype, first_byte: u8) !LengthMeta {
    var buf: [8]u8 = undefined;
    const length = first_byte & 0x7f;
    // if 0-125, payload length = 7 bits
    if (length <= 125) {
        return .{ .length = @intCast(length), .advance_cursor = 0 };
        // otherwise, interpret next 2 bytes as 16 bit integer
    } else if (length == 126) {
        try readAtLeastOrThrow(reader, buf[0..2], 2);
        return .{
            // FIXME: segfault here at readInt, I think?  but that doesn't make
            // sense because I'm never calling read_frame...
            .length = @intCast(std.mem.readInt(u16, @ptrCast(buf[0..2]), .big)),
            .advance_cursor = 2,
        };
        // otherwise, interpret next 8 bytes as u64
    } else if (length == 127) {
        try readAtLeastOrThrow(reader, &buf, 8);
        return .{
            .length = std.mem.readInt(u64, @ptrCast(&buf), .big),
            .advance_cursor = 8,
        };
    }

    unreachable;
}

fn readAtLeastOrThrow(reader: anytype, buf: []u8, len: usize) !void {
    const read_len = try reader.readAtLeast(buf, len);
    if (read_len < len) {
        if (read_len != 0) {
            // if we read _something_ but not what we expected, that's probably a bug.
            // on the other hand, reading 0 probably just means that the client closed
            // the connection, which we don't care to log
            std.log.err(
                "readAtLeastOrThrow: asserted {d} should be present but only could read {d}",
                .{ len, read_len },
            );
        }
        return ReadError.EndOfStream;
    }
}

test {
    const allocator = std.testing.allocator;

    // raw packet data that I got from wireshark (fin = true, opcode = text,
    // masking key = [0x50, 0x83, 0x2e, 0x05], payload data = "some payload data")
    const packet_bytes = [_]u8{
        // headers:
        0x81, 0x91, 0x6a, 0x4a, 0xac, 0xeb,
        // masked payload:
        0x19, 0x25, 0xc1, 0x8e, 0x4a, 0x3a,
        0xcd, 0x92, 0x6,  0x25, 0xcd, 0x8f,
        0x4a, 0x2e, 0xcd, 0x9f, 0xb,
    };

    var stream = std.io.fixedBufferStream(&packet_bytes);
    const reader = stream.reader();
    const Packet = FrameReader(@TypeOf(reader));
    const packet = try Packet.readFrame(allocator, reader);
    defer packet.deinit();

    try std.testing.expectEqual(packet.fin, true);
    try std.testing.expectEqual(packet.opcode, Opcode.text);
    try std.testing.expectEqualSlices(u8, packet.payload, "some payload data");
}
