import { redisUserStore, RedisUserStore } from './redis-user-store';

export { RedisUserStore as UserStore } from './redis-user-store';
export const userStore = redisUserStore;
export default redisUserStore;
