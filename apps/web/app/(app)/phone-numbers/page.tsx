import { Phone, PhoneOutgoing, Server, Waypoints } from "lucide-react";
import type { Metadata } from "next";
import { Page } from "@/components/app-shell";
import { Badge, Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Phone Numbers" };

const steps = [
  {
    icon: Server,
    title: "Bring a SIP trunk",
    body: "Create an Elastic SIP trunk with Twilio or Telnyx and buy (or port) a number on it.",
  },
  {
    icon: Waypoints,
    title: "Connect it to LiveKit",
    body: "Register the trunk as a LiveKit outbound trunk and set LIVEKIT_SIP_OUTBOUND_TRUNK_ID in the API's .env.",
  },
  {
    icon: PhoneOutgoing,
    title: "Place calls via the API",
    body: "POST /v1/calls/phone with agent_id, from_number and to_number. The API creates the LiveKit room, dispatches your agent and dials the callee as participant phone_user.",
  },
];

export default function PhoneNumbersPage() {
  return (
    <Page>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Phone Numbers <Badge tone="brand">Coming in phase 2</Badge>
          </span>
        }
        description="Buy, import and assign numbers to agents for inbound and outbound phone calls."
      />
      <Card className="overflow-hidden">
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <div className="mb-4 rounded-2xl border border-line bg-panel-2 p-4 text-violet-300">
            <Phone className="size-6" />
          </div>
          <h2 className="text-base font-semibold">Number management is coming in phase 2</h2>
          <p className="mt-2 max-w-xl text-sm text-muted">
            Outbound phone calls already work through the API today if your server has a SIP trunk configured. Without one,{" "}
            <code className="rounded bg-elevated px-1 py-0.5 font-mono text-xs">POST /v1/calls/phone</code> returns{" "}
            <code className="rounded bg-elevated px-1 py-0.5 font-mono text-xs">501 not_configured</code>.
          </p>
        </div>
        <div className="grid gap-px border-t border-line bg-line sm:grid-cols-3">
          {steps.map(({ icon: Icon, title, body }, i) => (
            <div key={title} className="bg-panel p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <span className="flex size-6 items-center justify-center rounded-full bg-brand-soft text-xs text-violet-300">{i + 1}</span>
                <Icon className="size-4 text-muted" />
                {title}
              </div>
              <p className="text-sm leading-relaxed text-muted">{body}</p>
            </div>
          ))}
        </div>
        <div className="border-t border-line bg-panel-2 p-5">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-subtle">Example</div>
          <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-4 font-mono text-xs leading-relaxed text-muted">{`curl -X POST $API_BASE_URL/v1/calls/phone \
  -H "Authorization: Bearer cl_live_..." \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"agent_...","from_number":"+14155550100","to_number":"+919876543210",
       "dynamic_variables":{"customer_name":"Asha"}}'`}</pre>
        </div>
      </Card>
    </Page>
  );
}
