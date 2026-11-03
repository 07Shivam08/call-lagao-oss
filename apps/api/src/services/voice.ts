import { AccessToken, AgentDispatchClient, RoomServiceClient, SipClient } from "livekit-server-sdk";
import type { Env } from "../env.js";

/** Everything the API needs from the media layer. Swapped for a fake in tests. */
export interface VoiceGateway {
  readonly configured: boolean;
  readonly sipConfigured: boolean;
  /** Dispatch the voice agent into room `callId` and mint a browser token for identity `user`. */
  startWebCall(callId: string): Promise<{ accessToken: string; livekitUrl: string }>;
  /** Dispatch the agent, then dial `toNumber` into the room through the outbound SIP trunk. */
  startPhoneCall(callId: string, fromNumber: string, toNumber: string): Promise<void>;
  endCall(callId: string): Promise<void>;
}

const httpUrl = (wsUrl: string) => wsUrl.replace(/^ws(s?):\/\//, "http$1://");

export function livekitGateway(env: Env): VoiceGateway {
  const { url, apiKey, apiSecret, agentName, sipOutboundTrunkId } = env.livekit;
  const configured = Boolean(url && apiKey && apiSecret);
  const host = configured ? httpUrl(url) : "";

  const dispatch = async (callId: string) => {
    const client = new AgentDispatchClient(host, apiKey, apiSecret);
    await client.createDispatch(callId, agentName, { metadata: JSON.stringify({ call_id: callId }) });
  };

  return {
    configured,
    sipConfigured: configured && Boolean(sipOutboundTrunkId),

    async startWebCall(callId) {
      await dispatch(callId);
      const at = new AccessToken(apiKey, apiSecret, { identity: "user", name: "Web caller", ttl: "15m" });
      at.addGrant({ room: callId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
      return { accessToken: await at.toJwt(), livekitUrl: url };
    },

    async startPhoneCall(callId, fromNumber, toNumber) {
      await dispatch(callId);
      const sip = new SipClient(host, apiKey, apiSecret);
      await sip.createSipParticipant(sipOutboundTrunkId, toNumber, callId, {
        fromNumber,
        participantIdentity: "phone_user",
        participantName: toNumber,
        playDialtone: false,
      });
    },

    async endCall(callId) {
      const rooms = new RoomServiceClient(host, apiKey, apiSecret);
      try {
        await rooms.deleteRoom(callId);
      } catch (e) {
        // already gone is fine
        if (!/not.?found/i.test(String((e as Error)?.message))) throw e;
      }
    },
  };
}
