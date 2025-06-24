const notifier = require('toasted-notifier');
import { APP_NAME } from './constants';

// This is a "fire-and-forget" utility. If notifications fail for any reason
// (e.g., unsupported OS, DND mode, permissions), it should not crash the app.
const sendNotification = (options: { title: string; message: string; enableNotifications?: boolean }) => {
    // Skip notification if explicitly disabled
    if (options.enableNotifications === false) {
        return;
    }
    
    try {
        notifier.notify(
            {
                title: options.title,
                message: options.message,
                sound: false, // Keep it quiet by default
                wait: false,
            },
            (err: any) => {
                if (err) {
                    // Silently ignore errors. This is a non-critical feature.
                }
            }
        );
    } catch (err) {
        // Silently ignore errors.
    }
};

export const createNotifier = (messageTemplate: (param: string) => string) => {
    return (param: string, enableNotifications: boolean = true) => {
        sendNotification({
            title: APP_NAME,
            message: messageTemplate(param),
            enableNotifications,
        });
    };
};

export const notifyPatchDetected = createNotifier(
    (projectId: string) => `New patch detected for project \`${projectId}\`.`
);

export const notifyApprovalRequired = createNotifier(
    (projectId: string) => `Action required to approve changes for \`${projectId}\`.`
);

export const notifySuccess = createNotifier(
    (uuid: string) => `Patch \`${uuid}\` applied successfully.`
);

export const notifyFailure = createNotifier(
    (uuid: string) => `Patch \`${uuid}\` failed and was rolled back.`
);