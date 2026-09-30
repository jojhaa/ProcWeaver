# Add project specific ProGuard rules here.
-keep class com.procweaver.mobile.NativeCore { *; }
-keepclassmembers class com.procweaver.mobile.ProcWeaverVpnService {
    public boolean protectSocket(int);
    public java.lang.String connectionPackage(int, java.lang.String, int, java.lang.String, int);
}
-keep class com.procweaver.mobile.VpnPlugin { *; }
-keep class com.procweaver.mobile.CoreArgs { *; }
-keep class com.procweaver.mobile.DocumentArgs { *; }
-keep class com.procweaver.mobile.MobileArgs { *; }
-keep class com.procweaver.mobile.HealthArgs { *; }
-keepclassmembers class com.procweaver.mobile.ProbeNetwork { public boolean protectSocket(int); }
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
-keep class com.procweaver.mobile.NativeRuntime { *; }
