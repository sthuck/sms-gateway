export type MetricLabels = Record<string, string>;

type CounterKey = string;

function keyOf(name: string, labels: MetricLabels): CounterKey {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ""}`);
  return `${name}|${parts.join(",")}`;
}

/**
 * Minimal Prometheus-style counter store (process-local). Exposed as text via
 * `renderPrometheus()` and also logged by the worker.
 */
export class QueueMetrics {
  readonly #counters = new Map<CounterKey, { name: string; labels: MetricLabels; value: number }>();

  inc(name: string, labels: MetricLabels = {}, by = 1): void {
    const key = keyOf(name, labels);
    const existing = this.#counters.get(key);
    if (existing) {
      existing.value += by;
      return;
    }
    this.#counters.set(key, { name, labels: { ...labels }, value: by });
  }

  get(name: string, labels: MetricLabels = {}): number {
    return this.#counters.get(keyOf(name, labels))?.value ?? 0;
  }

  snapshot(): Array<{ name: string; labels: MetricLabels; value: number }> {
    return [...this.#counters.values()].map((c) => ({
      name: c.name,
      labels: { ...c.labels },
      value: c.value,
    }));
  }

  renderPrometheus(): string {
    const byName = new Map<string, Array<{ labels: MetricLabels; value: number }>>();
    for (const entry of this.#counters.values()) {
      const list = byName.get(entry.name) ?? [];
      list.push({ labels: entry.labels, value: entry.value });
      byName.set(entry.name, list);
    }

    const lines: string[] = [];
    for (const [name, entries] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# TYPE ${name} counter`);
      for (const e of entries) {
        const labelKeys = Object.keys(e.labels).sort();
        const labelStr =
          labelKeys.length === 0
            ? ""
            : `{${labelKeys.map((k) => `${k}="${escapeLabel(e.labels[k] ?? "")}"`).join(",")}}`;
        lines.push(`${name}${labelStr} ${e.value}`);
      }
    }
    return lines.length === 0 ? "# no queue metrics yet\n" : `${lines.join("\n")}\n`;
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export const JOB_COMPLETED = "sms_gateway_queue_jobs_completed_total";
export const JOB_FAILED = "sms_gateway_queue_jobs_failed_total";
export const JOB_DEAD_LETTERED = "sms_gateway_queue_jobs_dead_lettered_total";
