import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Channel, ChannelModel, connect, ConsumeMessage } from 'amqplib';

export class NonRetryableMessageError extends Error {}

@Injectable()
export class RabbitMqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection?: ChannelModel;
  private channel?: Channel;

  async onModuleInit(): Promise<void> {
    const url = process.env.RABBITMQ_URL as string;
    const exchange = process.env.RABBITMQ_EXCHANGE as string;

    this.connection = await connect(url);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(exchange, 'topic', { durable: true });
    this.logger.log(`Connected to RabbitMQ exchange: ${exchange}`);
  }

  async publish(routingKey: string, payload: unknown): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ channel not initialized');
    const exchange = process.env.RABBITMQ_EXCHANGE as string;

    this.channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      contentType: 'application/json',
    });
  }

  async subscribe(
    queueName: string,
    routingKeys: string[],
    handler: (msg: ConsumeMessage) => Promise<void>,
  ): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ channel not initialized');
    const exchange = process.env.RABBITMQ_EXCHANGE as string;

    await this.channel.assertQueue(queueName, { durable: true });
    for (const routingKey of routingKeys) {
      await this.channel.bindQueue(queueName, exchange, routingKey);
    }

    await this.channel.consume(queueName, async (message) => {
      if (!message) return;
      try {
        await handler(message);
        this.channel?.ack(message);
      } catch (error) {
        this.logger.error(`Failed to process message from ${queueName}`, error as Error);
        const shouldRequeue = !this.isNonRetryableError(error);
        this.channel?.nack(message, false, shouldRequeue);
      }
    });
  }

  parseMessage<T>(message: ConsumeMessage): T {
    return JSON.parse(message.content.toString()) as T;
  }

  private isNonRetryableError(error: unknown): boolean {
    return error instanceof SyntaxError || error instanceof NonRetryableMessageError;
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }
}
