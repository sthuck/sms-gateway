# Release R8 / minify rules (STH-19). Libraries also ship consumer rules;
# these keep app-facing Retrofit, kotlinx.serialization, and entry points.

# --- General ---
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations

# --- kotlinx.serialization ---
-dontnote kotlinx.serialization.AnnotationsKt
-keep,includedescriptorclasses class com.sthuck.smsgateway.**$$serializer { *; }
-keepclassmembers class com.sthuck.smsgateway.** {
    *** Companion;
}
-keepclasseswithmembers class com.sthuck.smsgateway.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep class com.sthuck.smsgateway.data.remote.dto.** { *; }

# --- Retrofit / OkHttp ---
# Keep service method signatures so the HTTP annotations survive shrinking.
-keep,allowobfuscation,allowshrinking interface * {
    @retrofit2.http.* <methods>;
}
-keep,allowobfuscation,allowshrinking class * {
    @retrofit2.http.* <methods>;
}
-keepclassmembers,allowshrinking,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn retrofit2.**

# --- Hilt / Dagger / WorkManager (consumer rules cover most; keep app workers) ---
-keep class com.sthuck.smsgateway.**_HiltModules* { *; }
-keep class com.sthuck.smsgateway.**_HiltComponents* { *; }
-keep class * extends androidx.work.Worker
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context,androidx.work.WorkerParameters);
}

# --- Room ---
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class *
-dontwarn androidx.room.paging.**

# --- Manifest / reflection entry points ---
-keep class com.sthuck.smsgateway.SmsGatewayApplication { *; }
-keep class com.sthuck.smsgateway.MainActivity { *; }
-keep class com.sthuck.smsgateway.sms.SmsReceiver { *; }
-keep class com.sthuck.smsgateway.upload.BootUploadReceiver { *; }
-keep class com.sthuck.smsgateway.keepalive.GatewayKeepaliveService { *; }

# --- ML Kit / CameraX (barcode pairing) ---
-dontwarn com.google.mlkit.**
-keep class com.google.mlkit.** { *; }
