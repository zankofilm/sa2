package ir.madreseyar.student;

import android.content.Context;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/** Data-only FCM notifications: Android displays them even when the app is in background.
 * The phone must have connectivity and FCM must be configured on client and server. */
public final class SchoolMessagingService extends FirebaseMessagingService {
    @Override public void onMessageReceived(RemoteMessage message) {
        Map<String,String> d=message.getData();
        if(d.isEmpty())return;
        NotificationHelper.show(this,d.get("title"),d.get("body"),d.get("screen"),
            d.containsKey("eventId")?d.get("eventId"):message.getMessageId());
    }
    @Override public void onNewToken(String token) {
        super.onNewToken(token);
        // Native MainActivity will bind the new FCM token to the *authenticated* school account
        // at its next foreground connection. No student login credentials are stored here.
        getSharedPreferences("mobile-install",Context.MODE_PRIVATE).edit().putString("lastPushToken",token).apply();
    }
}
