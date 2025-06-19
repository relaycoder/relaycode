import { logger } from './logger';

export const getConfirmation = (question: string): Promise<boolean> => {
  return new Promise(resolve => {
    logger.prompt(question);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const onData = (text: string) => {
      const cleanedText = text.trim().toLowerCase();
      if (cleanedText === 'y' || cleanedText === 'yes') {
        resolve(true);
      } else {
        resolve(false);
      }
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };
    process.stdin.on('data', onData);
  });
};