import { MyPicksShell } from "@/components/account/my-picks-shell";
import { requireServerSession } from "@/lib/auth/supabase-auth";

export default async function MyPicksPage() {
  await requireServerSession("/my-picks");
  return <MyPicksShell />;
}
