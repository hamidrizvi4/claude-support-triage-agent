import { getQueueTickets, getToolCallsByTicket } from "@/lib/data/queries";
import { QueueView } from "@/components/queue/QueueView";

// Reviews mutate this list, so never serve it from the build cache.
export const dynamic = "force-dynamic";

export default async function QueuePage() {
  const [tickets, toolCallsByTicket] = await Promise.all([
    getQueueTickets(),
    getToolCallsByTicket(),
  ]);

  return <QueueView tickets={tickets} toolCallsByTicket={toolCallsByTicket} />;
}
