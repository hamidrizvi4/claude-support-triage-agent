import styles from "./shell.module.css";
import { Sidebar } from "@/components/Sidebar";
import { resolveModel } from "@/lib/model";

/**
 * The working app (review queue + dashboard) lives in this route group so it
 * keeps the fixed sidebar shell, while the marketing page at `/` renders
 * full-bleed without it.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <Sidebar model={resolveModel()} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
