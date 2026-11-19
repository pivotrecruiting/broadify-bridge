import { PGM_SDP_MAX_BYTES, PgmWebrtcOfferSchema, isSaneRecvonlyOffer } from "./pgm-command-schemas.js";

const OFFER = ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=recvonly", "a=rtpmap:96 H264/90000"].join("\r\n");

describe("isSaneRecvonlyOffer", () => {
  it("accepts one recvonly video section with optional audio", () => {
    expect(isSaneRecvonlyOffer(OFFER)).toBe(true);
    expect(isSaneRecvonlyOffer(`${OFFER}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly`)).toBe(true);
  });

  it("rejects what the bridge must never answer", () => {
    expect(isSaneRecvonlyOffer("")).toBe(false);
    expect(isSaneRecvonlyOffer(OFFER.replace("v=0", "v=1"))).toBe(false);
    expect(isSaneRecvonlyOffer(`${OFFER}\r\nm=video 9 UDP/TLS/RTP/SAVPF 97`)).toBe(false);
    expect(isSaneRecvonlyOffer(`${OFFER}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel`)).toBe(false);
    expect(isSaneRecvonlyOffer(`${OFFER}\r\na=ice-lite`)).toBe(false);
    expect(isSaneRecvonlyOffer(OFFER.replace("a=recvonly", "a=sendrecv"))).toBe(false);
    expect(isSaneRecvonlyOffer(`${OFFER}\r\n${"a=x\r\n".repeat(400)}`)).toBe(false);
    expect(isSaneRecvonlyOffer(`${OFFER}\r\na=${"x".repeat(PGM_SDP_MAX_BYTES)}`)).toBe(false);
  });
});

describe("PgmWebrtcOfferSchema", () => {
  const base = { session_id: "6f1d2c1e-9c2a-4a8e-9a0e-1b2c3d4e5f60", sdp: OFFER, viewer_user_id: "0b5a7f6e-3c4d-4e5f-8a9b-0c1d2e3f4a5b", ice_servers: [] };

  it("accepts a well-formed offer and rejects unknown keys", () => {
    expect(PgmWebrtcOfferSchema.safeParse(base).success).toBe(true);
    expect(PgmWebrtcOfferSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(PgmWebrtcOfferSchema.safeParse({ ...base, session_id: "nope" }).success).toBe(false);
    expect(PgmWebrtcOfferSchema.safeParse({ ...base, ice_servers: [{ urls: [] }] }).success).toBe(false);
  });
});
