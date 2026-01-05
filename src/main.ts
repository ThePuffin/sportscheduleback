import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import * as dotenv from 'dotenv';
dotenv.config();

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Enable CORS with default options (allows all origins)
  app.enableCors();
  app.use(helmet());
  await app.listen(PORT);
}
bootstrap();
