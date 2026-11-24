import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  // Without this, behind a proxy every client shares the proxy's IP (one login limit for all).
  const hops = app.get(ConfigService).getOrThrow<number>('TRUST_PROXY_HOPS');
  if (hops > 0) app.set('trust proxy', hops);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Mastiska API')
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
