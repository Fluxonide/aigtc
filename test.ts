import { getKiroAuth } from "./apps/cli/src/providers/api/kiro-auth.ts";
getKiroAuth().then(() => console.log("Success")).catch(e => console.error("TEST ERROR:", e));
