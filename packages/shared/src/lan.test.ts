import assert from "node:assert/strict"
import { test } from "node:test"

import { PEER_LAN_PORT } from "./constants.ts"
import {
  isPrivateLanAddr,
  ipv4Slash24,
  lanPeersForDevice,
  likelyLanPeer,
  peerTicketMessage,
  sanitizeLanAddrs,
  sanitizeLanPort,
} from "./lan.ts"

test("RFC1918 and ULA pass; loopback and link-local do not", () => {
  assert.equal(isPrivateLanAddr("10.0.0.5"), true)
  assert.equal(isPrivateLanAddr("172.16.1.9"), true)
  assert.equal(isPrivateLanAddr("192.168.1.20"), true)
  assert.equal(isPrivateLanAddr("fd12:3456:789a::1"), true)
  assert.equal(isPrivateLanAddr("fc00::1"), true)
  assert.equal(isPrivateLanAddr("8.8.8.8"), false)
  assert.equal(isPrivateLanAddr("127.0.0.1"), false)
  assert.equal(isPrivateLanAddr("169.254.1.1"), false)
  assert.equal(isPrivateLanAddr("::1"), false)
  assert.equal(isPrivateLanAddr("fe80::1"), false)
  assert.equal(isPrivateLanAddr("172.15.0.1"), false)
})

test("sanitizeLanAddrs drops public, duplicates, and caps", () => {
  assert.deepEqual(
    sanitizeLanAddrs(["10.0.0.5", "10.0.0.5", "1.1.1.1", "fd00::1", 3]),
    ["10.0.0.5", "fd00::1"]
  )
  assert.deepEqual(sanitizeLanAddrs(null), [])
  assert.equal(sanitizeLanPort(PEER_LAN_PORT), PEER_LAN_PORT)
  assert.equal(sanitizeLanPort(0), null)
})

test("likely LAN peer matches /24 or public Device.ip", () => {
  assert.equal(
    likelyLanPeer(
      { lanAddrs: ["10.0.0.8"], ip: "203.0.113.9" },
      { lanAddrs: ["10.0.0.22"], ip: "198.51.100.1" }
    ),
    true
  )
  assert.equal(
    likelyLanPeer(
      { lanAddrs: ["10.0.0.8"], ip: "203.0.113.9" },
      { lanAddrs: ["10.0.1.22"], ip: "203.0.113.9" }
    ),
    true
  )
  assert.equal(
    likelyLanPeer(
      { lanAddrs: ["10.0.0.8"], ip: "203.0.113.9" },
      { lanAddrs: ["10.0.1.22"], ip: "198.51.100.1" }
    ),
    false
  )
  assert.equal(ipv4Slash24("192.168.4.90"), "192.168.4.0")
})

test("lanPeersForDevice ranks likely online hosts first", () => {
  const peers = lanPeersForDevice({ id: "a", lanAddrs: ["192.168.1.10"], ip: "203.0.113.1" }, [
    { id: "a", hostname: "self", status: "online", ip: "203.0.113.1", lanAddrs: ["192.168.1.10"], lanPort: PEER_LAN_PORT },
    { id: "b", hostname: "zeta", status: "offline", ip: null, lanAddrs: ["192.168.1.11"], lanPort: PEER_LAN_PORT },
    { id: "c", hostname: "alpha", status: "online", ip: "198.51.100.2", lanAddrs: ["10.1.1.2"], lanPort: null },
    { id: "d", hostname: "beta", status: "online", ip: null, lanAddrs: ["192.168.1.12"], lanPort: PEER_LAN_PORT },
  ])
  assert.deepEqual(
    peers.map((p) => p.id),
    ["d", "b", "c"]
  )
  assert.equal(peers[0]?.likely, true)
  assert.equal(peers[2]?.likely, false)
})

test("peer ticket message is stable for HMAC", () => {
  const msg = peerTicketMessage({
    copyId: "c1",
    srcDeviceId: "src",
    dstDeviceId: "dst",
    srcPath: "C:\\a.txt",
    destPath: "C:\\b.txt",
    exp: 10,
    maxBytes: 100,
    port: PEER_LAN_PORT,
    addrs: ["10.0.0.2", "10.0.0.1"],
  })
  assert.equal(msg.startsWith("peer-copy-v1\n"), true)
  assert.equal(msg.includes("10.0.0.1,10.0.0.2"), true)
})
