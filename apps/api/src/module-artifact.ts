import fsp from "node:fs/promises"

export type PeArtifact = {
  kind: "exe" | "dll-plugin"
  arch: "amd64" | "arm64"
}

const MACHINE_ARCH = new Map<number, PeArtifact["arch"]>([
  [0x8664, "amd64"],
  [0xaa64, "arm64"],
])

export async function inspectPeArtifact(filePath: string): Promise<PeArtifact> {
  const handle = await fsp.open(filePath, "r")
  try {
    const header = Buffer.alloc(65_536)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const bytes = header.subarray(0, bytesRead)
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
      throw new Error("invalid_pe_dos_header")
    }
    const peOffset = bytes.readUInt32LE(0x3c)
    if (peOffset < 64 || peOffset + 24 > bytes.length)
      throw new Error("invalid_pe_offset")
    if (bytes.toString("binary", peOffset, peOffset + 4) !== "PE\u0000\u0000") {
      throw new Error("invalid_pe_signature")
    }
    const arch = MACHINE_ARCH.get(bytes.readUInt16LE(peOffset + 4))
    if (!arch) throw new Error("unsupported_pe_arch")
    if (bytes.readUInt16LE(peOffset + 6) < 1)
      throw new Error("pe_has_no_sections")
    const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20)
    if (
      optionalHeaderSize < 2 ||
      peOffset + 24 + optionalHeaderSize > bytes.length
    ) {
      throw new Error("invalid_pe_optional_header")
    }
    if (bytes.readUInt16LE(peOffset + 24) !== 0x20b)
      throw new Error("unsupported_pe_format")
    const characteristics = bytes.readUInt16LE(peOffset + 22)
    if ((characteristics & 0x0002) === 0) throw new Error("pe_not_executable")
    const kind = characteristics & 0x2000 ? "dll-plugin" : "exe"
    return { kind, arch }
  } finally {
    await handle.close()
  }
}
