import { notFound } from "next/navigation";
import RoutingEditor from "@/components/routing-editor";

export default function RoutingEditorPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <RoutingEditor />;
}
