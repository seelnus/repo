import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class FillAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new UnauthorizedException('请先完成企微授权');

    try {
      const payload = this.jwt.verify(token);
      if (payload.type !== 'fill') throw new Error('非填写端 token');
      request.fillUser = payload;
      return true;
    } catch {
      throw new UnauthorizedException('授权已过期，请重新登录');
    }
  }
}
