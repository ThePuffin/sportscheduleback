import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKeyHeader = request.header('x-api-key');
    const validApiKey = this.configService.get<string>('EXPO_PUBLIC_API_KEY');

    if (!validApiKey) {
      console.error('CRITICAL: API_KEY is not configured on the server.');
      throw new UnauthorizedException('Server configuration error.');
    }

    if (apiKeyHeader !== validApiKey) {
      throw new UnauthorizedException('Invalid or missing API Key.');
    }

    return true;
  }
}
