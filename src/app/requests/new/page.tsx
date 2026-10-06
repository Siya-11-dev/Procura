import { NewRequestForm } from "@/components/new-request-form";
import { Panel, PanelHeader } from "@/components/ui";
import { auth } from "@/auth";
import { AGENT_LABEL, AGENT_ROLE, AGENT_NAMES } from "@/lib/domain/types";

const FLOW = AGENT_NAMES.map((name, index) => ({
  name,
  label: AGENT_LABEL[name],
  role: AGENT_ROLE[name],
  step: index + 1,
}));

export default async function NewRequestPage() {
  const session = await auth();
  const user = session?.user;
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">
          Raise a purchase request
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-300">
          Write the request the way you would write it to a colleague. There is
          no form to get wrong and no category to pick — the Request Agent works
          out what you actually need and tells you what it had to assume.
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Panel>
          <PanelHeader
            title="Request"
            hint="Everything except the description is optional"
          />
          <div className="p-5">
            <NewRequestForm
              defaultName={user?.name ?? ""}
              defaultEmail={user?.email ?? ""}
              defaultDepartment={user?.department ?? ""}
            />
          </div>
        </Panel>

        <Panel className="h-fit">
          <PanelHeader
            title="What happens next"
            hint="Eight agents run in sequence, then the ninth on invoice"
          />
          <ol className="divide-y divide-ink-800">
            {FLOW.map((agent) => (
              <li key={agent.name} className="flex gap-3 px-5 py-3">
                <span className="mt-0.5 font-mono text-[11px] text-ink-500">
                  {String(agent.step).padStart(2, "0")}
                </span>
                <div>
                  <p className="text-sm font-medium text-ink-100">
                    {agent.label}
                  </p>
                  <p className="text-xs text-ink-400">{agent.role}</p>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}
