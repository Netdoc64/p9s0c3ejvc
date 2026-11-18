import { describe, expect, it } from "vitest";
import worker, { queue, scheduled } from "../src/index";

/**
 * Cloudflare ruft Handler NUR am Standardexport auf. Ein benannter Export
 * `scheduled`/`queue` wird still ignoriert — Cron-Jobs und Queue-Consumer
 * laufen dann nie, und jeder Test über `SELF.fetch` bleibt grün.
 */
describe("Worker-Einstieg", () => {
  it("trägt fetch, scheduled und queue am Standardexport", () => {
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
    expect(typeof worker.queue).toBe("function");
  });

  it("der Standardexport benutzt dieselben Handler wie die benannten Exporte", () => {
    expect(worker.scheduled).toBe(scheduled);
    expect(worker.queue).toBe(queue);
  });
});
