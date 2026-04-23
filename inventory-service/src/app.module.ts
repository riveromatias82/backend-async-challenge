import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import configuration from './common/config/configuration';
import { RabbitMqModule } from './common/rabbitmq/rabbitmq.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    MongooseModule.forRoot(process.env.MONGODB_URI as string),
    RabbitMqModule,
    HealthModule,
    InventoryModule,
    EventsModule,
  ],
})
export class AppModule {}
