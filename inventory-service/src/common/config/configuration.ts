export default () => ({
  port: parseInt(process.env.PORT || '3002', 10),
  mongodbUri: process.env.MONGODB_URI,
  rabbitmqUrl: process.env.RABBITMQ_URL,
  rabbitmqExchange: process.env.RABBITMQ_EXCHANGE || 'backend.async.challenge',
});
