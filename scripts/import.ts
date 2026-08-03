import { getConfig } from "@/lib/config";
import { importBak, type ImportMode, type Prefer } from "@/lib/backup/import";

const bak = process.argv[2];
const mode = (process.argv[3] ?? "dry-run") as ImportMode;
const prefer = (process.argv[4] ?? "incoming") as Prefer;

if (!bak) {
  console.error("usage: pnpm db:import <file.ptbak> [replace|merge|dry-run] [newer|local|incoming]");
  process.exit(2);
}

const rep = await importBak(bak, getConfig().dbPath, { mode, prefer });
console.log(JSON.stringify(rep, null, 2));
