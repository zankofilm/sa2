package ir.madreseyar.student;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class NotificationHelper {
    public static final String CHANNEL = "madreseyar_edu_updates_v1";
    private NotificationHelper(){}
    public static void createChannel(Context ctx) {
        NotificationManager manager=(NotificationManager)ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch=new NotificationChannel(CHANNEL,"پیام‌ها و اطلاعیه‌های مدرسه", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("پیام‌های معلمان، آزمون‌ها، تکالیف و اطلاعیه‌های مدرسه‌یار");
        manager.createNotificationChannel(ch);
    }
    public static void show(Context ctx, String title, String body, String section, String id) {
        createChannel(ctx);
        // Never accept a remote URL in a push intent; only a finite set of known in-app screens.
        if(!("chat".equals(section)||"exams".equals(section)||"tasks".equals(section)||"notifications".equals(section)||"home".equals(section)))section="notifications";
        Intent i=new Intent(ctx,MainActivity.class);
        i.putExtra("screen",section);
        i.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int n=id==null?0:id.hashCode();
        PendingIntent pi=PendingIntent.getActivity(ctx,n,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b=new Notification.Builder(ctx,CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title==null||title.isEmpty()?"مدرسه‌یار":title)
            .setContentText(body==null?"":body)
            .setAutoCancel(true).setContentIntent(pi).setCategory(Notification.CATEGORY_MESSAGE);
        NotificationManager manager=(NotificationManager)ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(n,b.build());
    }
}
