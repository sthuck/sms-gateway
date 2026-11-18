import { PgBoss, type ConstructorOptions } from "pg-boss";
import type { QueueConfig } from "./config.js";
import { loadQueueConfig } from "./config.js";

export type CreateBossOptions = {
  connectionString: string;
  queueConfig?: QueueConfig;
  /**
   * When true (migrator / bootstrap only), allow schema create + migrate.
   * Runtime API and worker must leave this false and use least-privilege `sms_app`.
   */
  installSchema?: boolean;
  applicationName?: string;
  /** Publisher-only processes can disable supervision timers. Default true. */
  supervise?: boolean;
  /** Cron/schedules are unused today. Default false. */
  schedule?: boolean;
  /** Test-only overrides (clock, spies). */
  test?: Pick<ConstructorOptions, "clock" | "__test__enableSpies">;
};

/**
 * Construct a PgBoss instance.
 *
 * Runtime (`installSchema: false`): schema must already exist (migration
 * bootstrap). Uses `createSchema: false` and `migrate: false`.
 *
 * Bootstrap (`installSchema: true`): migrator role installs/upgrades the
 * `pgboss` schema.
 */
export function createBoss(options: CreateBossOptions): PgBoss {
  const queueConfig = options.queueConfig ?? loadQueueConfig();
  const install = options.installSchema === true;

  const constructorOptions: ConstructorOptions = {
    connectionString: options.connectionString,
    schema: queueConfig.QUEUE_SCHEMA,
    createSchema: install,
    migrate: install,
    application_name:
      options.applicationName ?? (install ? "sms-gateway-queue-bootstrap" : "sms-gateway"),
    max: 5,
    schedule: options.schedule ?? false,
    supervise: options.supervise ?? true,
  };

  if (options.test?.clock) {
    constructorOptions.clock = options.test.clock;
  }
  if (options.test?.__test__enableSpies !== undefined) {
    constructorOptions.__test__enableSpies = options.test.__test__enableSpies;
  }

  return new PgBoss(constructorOptions);
}

export async function startBoss(options: CreateBossOptions): Promise<PgBoss> {
  const boss = createBoss(options);
  await boss.start();
  return boss;
}
