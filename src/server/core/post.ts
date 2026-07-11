import { reddit, redis } from '@devvit/web/server';

export const createPost = async () => {
  const post = await reddit.submitCustomPost({
    title: '⛏️ DIG DIG DIG — we are digging one big hole. Tap to help.',
  });

  // A single stickied "score board" comment. Players post their runs AS THEMSELVES
  // as replies to this (via the blackout screen) — the app never auto-comments.
  try {
    const board = await reddit.submitComment({
      id: post.id,
      text: '🏆 **DIG DIG DIG — Score Board**\n\nReached a new depth? Tap **💬 Post my run** on your blackout screen to drop your score here. Deepest runs, one breath at a time. ⛏️',
    });
    try {
      await board.distinguish(true); // sticky
    } catch {
      /* stickying needs mod scope; the thread still works unstickied */
    }
    await redis.set(`scorethread:${post.id}`, board.id);
  } catch (error) {
    console.error('score board comment failed:', error);
  }

  return post;
};
