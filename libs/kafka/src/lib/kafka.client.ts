import { Kafka, KafkaConfig, logLevel } from 'kafkajs';

let kafkaInstance: Kafka | null = null;

export function createKafkaClient(broker: string): Kafka {
  if (kafkaInstance) return kafkaInstance;

  const config: KafkaConfig = {
    clientId: 'forexedge',
    brokers: [broker],
    logLevel: logLevel.WARN,
    retry: {
      initialRetryTime: 300,
      retries: 10,
      // Fix: cap the retry time to prevent negative timeout overflow
      maxRetryTime: 30000,
      factor: 0.2,          // Fix: dampens exponential backoff growth
      multiplier: 1.5,      // Fix: prevents overflow on large retry counts
    },
  };

  kafkaInstance = new Kafka(config);
  return kafkaInstance;
}

// Pre-creates topics so the broker has time to register them
// before the producer sends the first message
export async function ensureTopicsExist(
  broker: string,
  topics: string[],
): Promise<void> {
  const kafka = createKafkaClient(broker);
  const admin = kafka.admin();

  await admin.connect();

  try {
    const existing = await admin.listTopics();
    const toCreate = topics
      .filter((t) => !existing.includes(t))
      .map((topic) => ({
        topic,
        numPartitions: 1,
        replicationFactor: 1,
      }));

    if (toCreate.length > 0) {
      await admin.createTopics({ topics: toCreate });
    }
  } finally {
    await admin.disconnect();
  }
}